import { useEffect, useState } from "react";

const NOTE_COLORS = ["#ffe066", "#ffd6a5", "#caffbf", "#9bf6ff", "#ffc6ff"];

function loadNotes() {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem("roomboard-notes");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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
  const [notes, setNotes] = useState(loadNotes);

  useEffect(() => {
    document.body.classList.toggle("theme-dark", isDark);
    localStorage.setItem("roomboard-theme", isDark ? "dark" : "light");
  }, [isDark]);

  useEffect(() => {
    localStorage.setItem("roomboard-notes", JSON.stringify(notes));
  }, [notes]);

  const addNote = () => {
    let author = localStorage.getItem("roomboard-author") || "";
    if (!author) {
      author = (window.prompt("Sign your notes — what's your name?") || "").trim();
      if (author) localStorage.setItem("roomboard-author", author);
    }
    const note = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text: "",
      votes: 0,
      author: author || "anonymous",
      color: NOTE_COLORS[notes.length % NOTE_COLORS.length],
    };
    setNotes((prev) => [...prev, note]);
  };

  const updateNote = (id, text) =>
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, text } : n)));

  const voteNote = (id) =>
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, votes: n.votes + 1 } : n)));

  const removeNote = (id) => setNotes((prev) => prev.filter((n) => n.id !== id));

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

      <main className="board" aria-label="Shared room board">
        {notes.length === 0 && (
          <p className="board-empty">Tap + to pin the first note.</p>
        )}
        {notes.map((note) => (
          <article className="note" style={{ background: note.color }} key={note.id}>
            <textarea
              className="note-text"
              value={note.text}
              placeholder="Write something…"
              onChange={(event) => updateNote(note.id, event.target.value)}
            />
            <div className="note-actions">
              <span className="note-author">{note.author || "anonymous"}</span>
              <button type="button" className="note-vote" onClick={() => voteNote(note.id)}>
                ▲ {note.votes}
              </button>
              <button
                type="button"
                className="note-remove"
                onClick={() => removeNote(note.id)}
                aria-label="Delete note"
              >
                ✕
              </button>
            </div>
          </article>
        ))}
        <button type="button" className="note-add" onClick={addNote} aria-label="Add a note">
          +
        </button>
      </main>

      <footer className="roomboard-footer">built live by Ensemble.</footer>
    </div>
  );
}
