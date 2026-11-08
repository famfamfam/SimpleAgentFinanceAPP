import * as db from "./db.js";
import { initialState, today, summarize } from "./model.js";
document.querySelector("#run").addEventListener("click", async (event) => {
  event.target.disabled = true;
  const output = document.querySelector("#result");
  try {
    output.textContent = "Создаем тестовые записи…";
    await db.initialize();
    const state = initialState();
    for (let i = 0; i < 10000; i++)
      state.entries.push({
        id: crypto.randomUUID(),
        kind: i % 10 ? "expense" : "income",
        amount: "123.45",
        accountId: state.accounts[0].id,
        categoryId: state.categories[i % 10 ? 0 : 8].id,
        date: today(),
        note: "Тестовая операция " + i,
        tags: "",
        version: 2,
        deleted: false,
      });
    await db.accept({ state, revision: 2, results: [] });
    const samples = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      const data = await db.load();
      summarize(data.state, data.state.entries);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    output.textContent = `Записей: 10 000\nЛокальное чтение и подсчет итогов, 7 запусков:\nМедиана: ${samples[3].toFixed(1)} мс\nМаксимум: ${samples.at(-1).toFixed(1)} мс\n\nЭто тест БД и расчета, не полный холодный запуск приложения.`;
    window.__benchmark = { count: 10000, samples };
  } catch (error) {
    output.textContent = error.message;
  } finally {
    event.target.disabled = false;
  }
});
