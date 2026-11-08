import { useEffect, useRef, useState } from "react";
import * as chat from "/chat-db.js";

const drafts = new Map();
export async function prepareVoice(original) {
  let context;
  try {
    context = new AudioContext();
    const decoded = await context.decodeAudioData(await original.arrayBuffer());
    if (decoded.duration <= 0 || decoded.duration > 60)
      throw Error("Запись должна быть не длиннее минуты");
    const offline = new OfflineAudioContext(
        1,
        Math.ceil(decoded.duration * 16000),
        16000,
      ),
      source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const mono = await offline.startRendering(),
      samples = mono.getChannelData(0),
      buffer = new ArrayBuffer(44 + samples.length * 2),
      data = new DataView(buffer);
    const text = (offset, value) =>
      [...value].forEach((c, i) => data.setUint8(offset + i, c.charCodeAt(0)));
    text(0, "RIFF");
    data.setUint32(4, buffer.byteLength - 8, true);
    text(8, "WAVEfmt ");
    data.setUint32(16, 16, true);
    data.setUint16(20, 1, true);
    data.setUint16(22, 1, true);
    data.setUint32(24, 16000, true);
    data.setUint32(28, 32000, true);
    data.setUint16(32, 2, true);
    data.setUint16(34, 16, true);
    text(36, "data");
    data.setUint32(40, samples.length * 2, true);
    samples.forEach((s, i) =>
      data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true),
    );
    return {
      audio: chat.bufferBase64(buffer),
      original,
      label: `Голос · ${Math.ceil(decoded.duration)} сек.`,
    };
  } finally {
    if (context && context.state !== "closed")
      await context.close().catch(() => {});
  }
}
export async function prepareImage(file) {
  if (file.size > 15 << 20) throw Error("Фото слишком большое");
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height)),
      canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas
      .getContext("2d")
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return {
      image: canvas.toDataURL("image/jpeg", 0.82),
      label: "Фото чека · " + file.name,
    };
  } catch (error) {
    throw Error(
      error.name === "InvalidStateError"
        ? "Не удалось прочитать фото. Выберите JPEG или PNG"
        : error.message,
    );
  } finally {
    bitmap?.close();
  }
}
export function useAssistantMedia(scope, fail) {
  const [state, setState] = useState(() => ({
    attachment: drafts.get(scope) || null,
    busy: false,
    recording: false,
    seconds: 0,
  }));
  const live = useRef(true),
    value = useRef(state),
    recorder = useRef(),
    stream = useRef(),
    done = useRef(),
    cancelled = useRef(false),
    timers = useRef([]);
  const publish = (patch) => {
    value.current = { ...value.current, ...patch };
    if ("attachment" in patch) {
      if (patch.attachment) drafts.set(scope, patch.attachment);
      else drafts.delete(scope);
    }
    if (live.current) setState(value.current);
  };
  const release = () => {
    timers.current.forEach((id) => {
      clearTimeout(id);
      clearInterval(id);
    });
    timers.current = [];
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    recorder.current = null;
  };
  const stop = (abort = false) => {
    if (abort) cancelled.current = true;
    if (recorder.current?.state === "recording") recorder.current.stop();
    stream.current?.getTracks().forEach((t) => t.stop());
  };
  useEffect(() => {
    live.current = true;
    const hidden = () => {
      if (document.hidden) stop();
    };
    const pagehide = () => {
      live.current = false;
      stop();
    };
    const pageshow = () => {
      live.current = true;
      setState(value.current);
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("pageshow", pageshow);
    return () => {
      live.current = false;
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("pageshow", pageshow);
      stop();
    };
  }, [scope]);
  const prepare = async () => {
    if (value.current.busy || !value.current.attachment?.original) return;
    publish({ busy: true });
    try {
      publish({
        attachment: await prepareVoice(value.current.attachment.original),
      });
    } finally {
      publish({ busy: false });
    }
  };
  const record = async () => {
    if (recorder.current) {
      stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
      throw Error(
        "Запись недоступна. Используйте диктовку клавиатуры или текст",
      );
    if (value.current.busy) throw Error("Дождитесь обработки вложения");
    publish({ busy: true });
    let source, capture;
    try {
      source = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!live.current || document.hidden || location.hash !== "#assistant") {
        source.getTracks().forEach((t) => t.stop());
        return;
      }
      capture = new MediaRecorder(source);
    } catch (error) {
      source?.getTracks().forEach((t) => t.stop());
      throw Error(
        error.name === "NotAllowedError"
          ? "Разрешите доступ к микрофону в настройках браузера или используйте диктовку клавиатуры"
          : "Не удалось включить микрофон",
      );
    } finally {
      publish({ busy: false });
    }
    const chunks = [],
      started = Date.now();
    recorder.current = capture;
    stream.current = source;
    cancelled.current = false;
    let resolve;
    const completion = new Promise((r) => {
      resolve = r;
    });
    done.current = completion;
    const finish = (result) => {
      resolve(result);
      if (done.current === completion) done.current = null;
    };
    capture.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    capture.onstop = async () => {
      release();
      publish({ recording: false, busy: true });
      try {
        if (cancelled.current) {
          finish(false);
          return;
        }
        const original =
          chunks.length === 1
            ? chunks[0]
            : new Blob(chunks, {
                type: capture.mimeType || chunks[0]?.type || "audio/webm",
              });
        publish({ attachment: { original, label: "Голосовая запись" } });
        publish({ attachment: await prepareVoice(original) });
        finish(true);
      } catch (error) {
        const message =
          "Не удалось подготовить WAV. Запись можно прослушать и повторить подготовку";
        if (value.current.attachment)
          publish({
            attachment: { ...value.current.attachment, error: message },
          });
        if (live.current) fail(Error(message));
        finish(false);
      } finally {
        publish({ busy: false });
      }
    };
    capture.onerror = () => {
      cancelled.current = true;
      stop(true);
      release();
      publish({ recording: false, busy: false });
      finish(false);
      if (live.current) fail(Error("Запись прервалась. Попробуйте ещё раз"));
    };
    try {
      capture.start();
      publish({ attachment: null, recording: true, seconds: 0 });
      timers.current = [
        setInterval(
          () => publish({ seconds: Math.floor((Date.now() - started) / 1000) }),
          1000,
        ),
        setTimeout(() => stop(), 55000),
      ];
    } catch {
      release();
      finish(false);
      publish({ recording: false, busy: false });
      throw Error(
        "Не удалось начать запись. Используйте диктовку клавиатуры или текст",
      );
    }
  };
  return {
    ...state,
    get attachmentValue() {
      return value.current.attachment;
    },
    active: () => value.current,
    record,
    stop,
    prepare,
    clear: () => publish({ attachment: null }),
    image: async (file) => {
      if (value.current.busy || recorder.current)
        throw Error("Сначала закончите запись или обработку вложения");
      publish({ busy: true });
      try {
        publish({ attachment: await prepareImage(file) });
      } finally {
        publish({ busy: false });
      }
    },
    ready: async () => {
      if (recorder.current) {
        const pending = done.current;
        stop();
        if (!(await pending))
          throw Error(
            "Запись не отправлена. Прослушайте её и повторите подготовку",
          );
      } else if (value.current.busy) {
        if (done.current) {
          if (!(await done.current))
            throw Error("Не удалось подготовить запись");
        } else throw Error("Дождитесь обработки вложения");
      }
      if (value.current.attachment?.original && !value.current.attachment.audio)
        await prepare();
      return value.current.attachment;
    },
  };
}
