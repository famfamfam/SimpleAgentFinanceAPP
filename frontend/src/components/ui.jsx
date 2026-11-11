import { t } from "/i18n.js";
import { useEffect, useRef } from "react";
import { paths } from "/icons.js";

export function Icon({ name, className = "" }) {
  return (
    <svg className={`svg ${className}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name] || paths.dots} />
    </svg>
  );
}
export function ColoredIcon({ category, fallback, id }) {
  const color = /^#[0-9a-f]{6}$/i.test(category?.color)
    ? category.color
    : "#5b8b67";
  return (
    <span
      id={id}
      className="category-icon"
      style={{ backgroundColor: color, color: "#F2F5F3" }}
    >
      <Icon name={fallback || category?.icon} />
    </span>
  );
}
export function Dialog({ title, onClose, children, wide = false }) {
  const ref = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = ref.current;
    el.showModal();
    el.querySelector('[data-action="close"]').focus({ preventScroll: true });
    el.scrollTop = 0;
    window.dispatchEvent(new Event("finance-dialog-change"));
    const cancel = (event) => {
      event.preventDefault();
      close.current?.();
    };
    el.addEventListener("cancel", cancel);
    return () => {
      el.removeEventListener("cancel", cancel);
      el.close();
      window.dispatchEvent(new Event("finance-dialog-change"));
    };
  }, []);
  return (
    <dialog
      ref={ref}
      id="modal"
      className={wide ? "wide" : ""}
      aria-label={title}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          onClose?.();
      }}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={t("Закрыть")}
          data-action="close"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
