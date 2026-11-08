import { Component } from "react";
import { createRoot } from "react-dom/client";
import * as db from "/db.js";
import { FinanceProvider } from "./FinanceProvider.jsx";
import App from "./App.jsx";
import "./theme.css";
import "./app.css";

class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <BootError error={this.state.error} />
    ) : (
      this.props.children
    );
  }
}
function BootError({ error }) {
  return (
    <main className="boot">
      <span className="brand-mark">₽</span>
      <h2>Не удалось открыть учет</h2>
      <p className="small">{error.message}</p>
      <button className="primary" onClick={() => location.reload()}>
        Повторить
      </button>
    </main>
  );
}
const root = createRoot(document.getElementById("app"));
async function start() {
  if (!isSecureContext || !crypto.randomUUID || !window.indexedDB)
    throw Error(
      "Для офлайн-приложения нужен HTTPS или localhost. Откройте адрес HTTPS из инструкции запуска.",
    );
  await db.initialize();
  root.render(
    <ErrorBoundary>
      <FinanceProvider>
        <App />
      </FinanceProvider>
    </ErrorBoundary>,
  );
}
start().catch((error) => root.render(<BootError error={error} />));
