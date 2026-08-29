import { useEffect, useState } from "react";

const NOTE_COLORS = ["#ffe066", "#ffd6a5", "#caffbf", "#9bf6ff", "#ffc6ff"];

function readStorage(key) {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Keep the board usable when an embedded browser blocks storage access.
  }
}

function removeStorage(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Keep the in-memory signer when an embedded browser blocks storage access.
  }
}

function loadNotes() {
  try {
    const raw = readStorage("roomboard-notes");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadAuthor() {
  return readStorage("roomboard-author")?.trim() ?? "";
}

export default function App() {
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    const saved = readStorage("roomboard-theme");
    if (saved === "dark") return true;
    if (saved === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const [notes, setNotes] = useState(loadNotes);
  const [author, setAuthor] = useState(loadAuthor);

  useEffect(() => {
    document.body.classList.toggle("theme-dark", isDark);
    writeStorage("roomboard-theme", isDark ? "dark" : "light");
  }, [isDark]);

  useEffect(() => {
    writeStorage("roomboard-notes", JSON.stringify(notes));
  }, [notes]);

  useEffect(() => {
    const name = author.trim();
    if (name) {
      writeStorage("roomboard-author", name);
    } else {
      removeStorage("roomboard-author");
    }
  }, [author]);

  const addNote = () => {
    const note = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text: "",
      votes: 0,
      author: author.trim() || "anonymous",
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

      <div className="signer-row">
        <label className="signer-control">
          <span>signing as</span>
          <input
            type="text"
            value={author}
            onChange={(event) => setAuthor(event.target.value)}
            placeholder="your name"
            autoComplete="name"
            maxLength={40}
          />
        </label>
      </div>

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
