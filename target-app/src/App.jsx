import { useEffect, useState } from "react";

export default function App() {
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    const saved = localStorage.getItem("roomboard-theme");
    if (saved === "dark") return true;
    if (saved === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    document.body.classList.toggle("theme-dark", isDark);
    localStorage.setItem("roomboard-theme", isDark ? "dark" : "light");
  }, [isDark]);

  return (
    <div className="roomboard-shell">
      <header className="title-bar">
        <div className="brand-mark" aria-hidden="true">
          R
        </div>
        <div className="title-copy">
          <h1>Roomboard</h1>
          <p>A shared wall for the room</p>
        </div>
        <button
          type="button"
          className="theme-toggle"
          onClick={() => setIsDark((prev) => !prev)}
          aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
        >
          {isDark ? "☀️" : "🌙"}
        </button>
      </header>

      <main className="board" aria-label="Empty shared room board" />

      <footer className="roomboard-footer">built live by Ensemble.</footer>
    </div>
  );
}
