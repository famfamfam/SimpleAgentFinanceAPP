package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"time"
)

// At the enforced $0.20/$0.40 per-million price ceiling, a full 1M-token call fits this reservation.
const aiCallReserveMicros int64 = 250_000

func aiDailyBudget() (int64, error) {
	cents, err := money(env("AI_DAILY_BUDGET_USD", "1.00"))
	if err != nil || cents < 25 || cents > 100_000 {
		return 0, errors.New("AI_DAILY_BUDGET_USD must be between 0.25 and 1000.00")
	}
	return cents * 10_000, nil
}

func (a *App) reserveAICall(ctx context.Context) (string, error) {
	budget, err := aiDailyBudget()
	if err != nil {
		return "", err
	}
	now := time.Now().UTC()
	key := "finance:ai-budget:" + now.Format("2006-01-02")
	script := `local n=tonumber(redis.call('GET',KEYS[1]) or '0');
if n+tonumber(ARGV[1])>tonumber(ARGV[2]) then return 0 end;
redis.call('INCRBY',KEYS[1],ARGV[1]); redis.call('EXPIRE',KEYS[1],172800); return 1`
	allowed, err := a.redis.Eval(ctx, script, []string{key}, aiCallReserveMicros, budget).Int()
	if err != nil {
		return "", apiError{503, "Учет расходов помощника временно недоступен"}
	}
	if allowed == 0 {
		return "", apiError{429, "Дневной лимит расходов на помощника исчерпан. Повторите завтра"}
	}
	return key, nil
}

func (a *App) settleAICall(key string, usage json.RawMessage) {
	var data struct {
		Cost *float64 `json:"cost"`
	}
	if json.Unmarshal(usage, &data) != nil || data.Cost == nil || math.IsNaN(*data.Cost) || math.IsInf(*data.Cost, 0) || *data.Cost < 0 || *data.Cost > 1000 {
		return // Keep the reservation when billing is unknown, including interrupted calls.
	}
	actual := int64(math.Ceil(*data.Cost * 1_000_000))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := a.redis.IncrBy(ctx, key, actual-aiCallReserveMicros).Err(); err != nil {
		slog.Warn("AI budget settlement failed", "error", err)
	}
}

func (a *App) acquireAISlot(ctx context.Context) (func(), error) {
	id := newID()
	now := time.Now().UnixMilli()
	script := `redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]);
if redis.call('ZCARD',KEYS[1])>=2 then return 0 end;
redis.call('ZADD',KEYS[1],ARGV[2],ARGV[3]); redis.call('EXPIRE',KEYS[1],90); return 1`
	allowed, err := a.redis.Eval(ctx, script, []string{"finance:ai-active"}, now, now+80_000, id).Int()
	if err != nil {
		return nil, apiError{503, "Помощник временно недоступен"}
	}
	if allowed == 0 {
		return nil, apiError{429, "Помощник занят. Повторите через несколько секунд"}
	}
	return func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		a.redis.ZRem(ctx, "finance:ai-active", id)
	}, nil
}
