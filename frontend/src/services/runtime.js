import { useEffect, useState } from "react";
import * as db from "/db.js";
import * as chat from "/chat-db.js";
import { api, sync, syncChat } from "/sync.js";
import { useFinance } from "../FinanceProvider.jsx";
import { startAssistantWorker } from "./assistant.js";
import { writeDraft } from "./draft.js";

export function useRuntime() {
  const { refresh, toast, fail, revealEntries } = useFinance();
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    let live = true,
      registration,
      applying = false,
      lastCheck = 0,
      timeout,
      workerListeners = [];
    const stopWorker = startAssistantWorker({
      refresh,
      toast,
      fail,
      revealEntries,
    });
    const synchronize = async (manual = false) => {
      try {
        await sync({ wait: manual });
        await syncChat();
      } catch (error) {
        if (manual) fail(error);
      } finally {
        await refresh().catch(fail);
      }
    };
    const background = () => synchronize(),
      manualSync = () => synchronize(true);
    const loadMe = async () => {
      try {
        const settings = await db.meta("settings");
        if (!settings.connected || settings.revoked) return;
        const me = await api("/api/me");
        if (me.user.id !== settings.userId) return;
        const members = await api(
          `/api/books/${settings.bookId}/members`,
          undefined,
          undefined,
          settings.userId,
        );
        const latest = await db.meta("settings");
        if (
          latest.bookId !== settings.bookId ||
          latest.userId !== settings.userId
        )
          return;
        await db.setMeta("settings", {
          ...latest,
          members,
          nickname: me.user.nickname,
          authRequired: false,
        });
        await refresh();
      } catch (error) {
        if (![401, 403].includes(error.status) && navigator.onLine)
          console.info("Account data unavailable");
      }
    };
    const check = async (manual = false) => {
      if (!navigator.onLine) {
        if (manual) toast("Для проверки обновлений подключитесь к сети");
        return;
      }
      if (!registration) {
        if (manual)
          toast("Офлайн-кеш ещё не готов. Повторите после загрузки приложения");
        return;
      }
      if (!manual && Date.now() - lastCheck < 60000) return;
      lastCheck = Date.now();
      await registration.update();
      if (registration.waiting && live) setUpdateReady(true);
      if (manual)
        toast(
          registration.waiting
            ? "Новая версия готова: нажмите «Обновить»"
            : "Проверка выполнена. Если есть новая версия, кнопка появится после её загрузки",
        );
    };
    const apply = async () => {
      if (
        document.querySelector("dialog[open]") ||
        document.querySelector(".recording,.audio-preview,.attachment img") ||
        document.querySelector("#ai-attachment")?.textContent?.trim()
      ) {
        toast(
          "Сначала сохраните или закройте форму и закончите работу с вложением",
        );
        return;
      }
      const worker = registration?.waiting;
      if (!worker) {
        setUpdateReady(false);
        await check(true);
        return;
      }
      const field = document.querySelector("#ai-text");
      if (field) {
        const settings = await db.meta("settings");
        if (field.dataset.draftScope !== chat.scopeOf(settings))
          throw Error("Книга или пользователь изменились. Обновите экран");
        await writeDraft(settings, field.value);
      }
      applying = true;
      worker.postMessage("ACTIVATE_UPDATE");
      timeout = setTimeout(() => {
        if (applying) {
          applying = false;
          toast(
            "Обновление не завершилось. Сохраните данные и откройте приложение заново",
          );
        }
      }, 15000);
    };
    const controller = () => {
      if (applying) location.reload();
    };
    const watch = () => {
      const worker = registration?.installing;
      if (worker) {
        const state = () => {
          if (
            worker.state === "installed" &&
            navigator.serviceWorker.controller &&
            live
          )
            setUpdateReady(true);
        };
        worker.addEventListener("statechange", state);
        workerListeners.push(() =>
          worker.removeEventListener("statechange", state),
        );
      }
    };
    if ("serviceWorker" in navigator && !import.meta.env.DEV)
      navigator.serviceWorker
        .register("/sw.js", { updateViaCache: "none" })
        .then((r) => {
          if (!live) return;
          registration = r;
          r.addEventListener("updatefound", watch);
          watch();
          if (r.waiting) setUpdateReady(true);
        })
        .catch(() => {
          if (live)
            toast(
              "Офлайн-запуск пока недоступен. Проверьте соединение и настройки браузера.",
            );
        });
    const visible = () => {
      if (!document.hidden) {
        background();
        check().catch(fail);
      }
    };
    const manual = (e) => check(!!e.detail).catch(fail),
      activate = () => apply().catch(fail);
    const viewport = () => {
      const v = window.visualViewport,
        height = v?.height || innerHeight,
        offset = v?.offsetTop || 0;
      document.documentElement.dataset.keyboard = String(
        height < 550 && !!document.querySelector(".assistant"),
      );
      document.documentElement.style.setProperty(
        "--keyboard-offset",
        Math.max(0, innerHeight - height - offset) + "px",
      );
      const log = document.querySelector(".assistant"),
        nav = document.querySelector(".nav");
      if (log)
        log.style.setProperty(
          "--chat-height",
          Math.max(
            100,
            height +
              offset -
              log.getBoundingClientRect().top -
              (nav?.offsetHeight || 70) -
              16,
          ) + "px",
        );
    };
    const events = {
      online: background,
      "finance-check-update": manual,
      "finance-apply-update": activate,
      "finance-sync": manualSync,
      hashchange: viewport,
      resize: viewport,
      "finance-chat-layout": viewport,
    };
    for (const [name, fn] of Object.entries(events))
      window.addEventListener(name, fn);
    navigator.serviceWorker?.addEventListener("controllerchange", controller);
    document.addEventListener("visibilitychange", visible);
    window.visualViewport?.addEventListener("resize", viewport);
    window.visualViewport?.addEventListener("scroll", viewport);
    const timer = setInterval(background, 30000),
      prune = setInterval(() => chat.prune().catch(() => {}), 3600000);
    background();
    loadMe();
    viewport();
    return () => {
      live = false;
      stopWorker();
      clearInterval(timer);
      clearInterval(prune);
      clearTimeout(timeout);
      for (const [name, fn] of Object.entries(events))
        window.removeEventListener(name, fn);
      document.removeEventListener("visibilitychange", visible);
      navigator.serviceWorker?.removeEventListener(
        "controllerchange",
        controller,
      );
      registration?.removeEventListener("updatefound", watch);
      workerListeners.forEach((fn) => fn());
      window.visualViewport?.removeEventListener("resize", viewport);
      window.visualViewport?.removeEventListener("scroll", viewport);
    };
  }, [refresh, toast, fail, revealEntries]);
  return updateReady;
}
