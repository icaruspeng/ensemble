import { useEffect, useRef, useState } from "react";
import "@google/model-viewer";
import sampleModelUrl from "./assets/roomboard-gem.glb?url&no-inline";

const NOTE_COLORS = ["#6f73c9", "#8570a8", "#52798b", "#8a637c", "#5f766e"];
const LEGACY_NOTE_COLORS = {
  "#ffe066": NOTE_COLORS[0],
  "#ffd6a5": NOTE_COLORS[1],
  "#caffbf": NOTE_COLORS[2],
  "#9bf6ff": NOTE_COLORS[3],
  "#ffc6ff": NOTE_COLORS[4],
};
const MODEL_SUFFIX = /\.(?:glb|gltf)$/i;

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

function getModelSource(value) {
  if (typeof value !== "string") return null;

  const source = value.trim();
  if (!source || /\s/.test(source) || !MODEL_SUFFIX.test(source)) return null;

  try {
    const url = new URL(source, "https://roomboard.local/");
    return url.protocol === "http:" || url.protocol === "https:" ? source : null;
  } catch {
    return null;
  }
}

function getStoredModelSource(value) {
  if (typeof value !== "string") return null;

  const source = value.trim();
  if (!source || /\s/.test(source)) return null;

  try {
    const url = new URL(source, "https://roomboard.local/");
    const canLoad = url.protocol === "http:" || url.protocol === "https:";
    return canLoad && MODEL_SUFFIX.test(url.pathname) ? source : null;
  } catch {
    return null;
  }
}

function normalizeVotes(value) {
  const votes = Number(value);
  return Number.isFinite(votes) && votes > 0 ? Math.floor(votes) : 0;
}

function normalizeNotes(value) {
  if (!Array.isArray(value)) return [];

  const usedIds = new Set();

  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];

    const candidateId =
      typeof entry.id === "string" && entry.id.trim()
        ? entry.id
        : `legacy-${index}`;
    let id = candidateId;
    let duplicate = 1;
    while (usedIds.has(id)) {
      id = `${candidateId}-${index}-${duplicate}`;
      duplicate += 1;
    }
    usedIds.add(id);
    const author =
      typeof entry.author === "string" && entry.author.trim()
        ? entry.author.trim().slice(0, 40)
        : "anonymous";
    const votes = normalizeVotes(entry.votes);
    const storedColor =
      typeof entry.color === "string" ? entry.color.toLowerCase() : "";
    const color = NOTE_COLORS.includes(storedColor)
      ? storedColor
      : LEGACY_NOTE_COLORS[storedColor] ?? NOTE_COLORS[index % NOTE_COLORS.length];
    const storedSource = getStoredModelSource(entry.src);

    if (entry.type === "model" && storedSource) {
      return [{ id, type: "model", src: storedSource, author, votes, color }];
    }

    const text = typeof entry.text === "string" ? entry.text : "";
    const detectedSource = getModelSource(text);

    if (detectedSource) {
      return [{ id, type: "model", src: detectedSource, author, votes, color }];
    }

    return [{ id, type: "note", text, author, votes, color }];
  });
}

function loadNotes() {
  try {
    const raw = readStorage("roomboard-notes");
    return normalizeNotes(raw ? JSON.parse(raw) : []);
  } catch {
    return [];
  }
}

function loadAuthor() {
  return readStorage("roomboard-author")?.trim() ?? "";
}

function createCardId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function CardActions({ card, onVote, onRemove }) {
  const label = card.type === "model" ? "3D model" : "note";

  return (
    <div className="note-actions">
      <span className="note-author">{card.author || "anonymous"}</span>
      <button
        type="button"
        className="note-vote"
        onClick={() => onVote(card.id)}
        aria-label={`Vote for ${label} by ${card.author || "anonymous"}; ${card.votes} votes`}
      >
        <span aria-hidden="true">▲</span> {card.votes}
      </button>
      <button
        type="button"
        className="note-remove"
        onClick={() => onRemove(card.id)}
        aria-label={`Delete ${label}`}
      >
        ✕
      </button>
    </div>
  );
}

function ModelCard({ card, onVote, onRemove }) {
  const [loadFailed, setLoadFailed] = useState(false);

  return (
    <article className="note model-card" style={{ "--note-hue": card.color }}>
      <div className="model-stage">
        <model-viewer
          src={card.src}
          alt={`Interactive 3D model shared by ${card.author || "anonymous"}`}
          camera-controls
          auto-rotate
          auto-rotate-delay="600"
          rotation-per-second="18deg"
          interaction-prompt="auto"
          shadow-intensity="1"
          exposure="1.05"
          loading="eager"
          onLoad={() => setLoadFailed(false)}
          onError={() => setLoadFailed(true)}
        />
        <span className="model-badge" aria-hidden="true">
          3d
        </span>
        {loadFailed && (
          <p className="model-error" role="status">
            This model couldn’t be loaded.
          </p>
        )}
      </div>
      <CardActions card={card} onVote={onVote} onRemove={onRemove} />
    </article>
  );
}

export default function App() {
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === "undefined") return true;
    const saved = readStorage("roomboard-theme-v2");
    if (saved === "dark") return true;
    if (saved === "light") return false;
    return true;
  });
  const [notes, setNotes] = useState(loadNotes);
  const [author, setAuthor] = useState(loadAuthor);
  const [addMode, setAddMode] = useState(null);
  const [modelUrl, setModelUrl] = useState("");
  const [modelError, setModelError] = useState("");
  const addControlRef = useRef(null);
  const addButtonRef = useRef(null);
  const modelInputRef = useRef(null);

  useEffect(() => {
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", isDark ? "#050505" : "#f3f1ec");
    writeStorage("roomboard-theme-v2", isDark ? "dark" : "light");
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

  useEffect(() => {
    if (addMode === "model") modelInputRef.current?.focus();
  }, [addMode]);

  useEffect(() => {
    if (!addMode) return undefined;

    const closePanel = () => {
      setAddMode(null);
      setModelUrl("");
      setModelError("");
    };
    const handlePointerDown = (event) => {
      if (!addControlRef.current?.contains(event.target)) closePanel();
    };
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      closePanel();
      addButtonRef.current?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [addMode]);

  const closeAddPanel = () => {
    setAddMode(null);
    setModelUrl("");
    setModelError("");
  };

  const addNote = () => {
    setNotes((previous) => [
      ...previous,
      {
        id: createCardId(),
        type: "note",
        text: "",
        votes: 0,
        author: author.trim() || "anonymous",
        color: NOTE_COLORS[previous.length % NOTE_COLORS.length],
      },
    ]);
    closeAddPanel();
  };

  const addModel = (source) => {
    setNotes((previous) => [
      ...previous,
      {
        id: createCardId(),
        type: "model",
        src: source,
        votes: 0,
        author: author.trim() || "anonymous",
        color: NOTE_COLORS[previous.length % NOTE_COLORS.length],
      },
    ]);
    closeAddPanel();
  };

  const submitModel = (event) => {
    event.preventDefault();
    const source = getModelSource(modelUrl);

    if (!source) {
      setModelError("Enter a model URL ending in .glb or .gltf.");
      return;
    }

    addModel(source);
  };

  const updateNote = (id, text) =>
    setNotes((previous) =>
      previous.map((note) => {
        if (note.id !== id) return note;
        const source = getModelSource(text);
        return source
          ? { ...note, type: "model", src: source, text: undefined }
          : { ...note, type: "note", text };
      }),
    );

  const voteNote = (id) =>
    setNotes((previous) =>
      previous.map((note) =>
        note.id === id ? { ...note, votes: normalizeVotes(note.votes) + 1 } : note,
      ),
    );

  const removeNote = (id) =>
    setNotes((previous) => previous.filter((note) => note.id !== id));

  return (
    <div className="roomboard-shell">
      <header className="title-bar">
        <div className="brand-mark" aria-hidden="true" />
        <div className="title-copy">
          <h1
            title="a shared wall for the room"
            aria-label="roomboard, a shared wall for the room"
          >
            roomboard
          </h1>
        </div>
        <button
          type="button"
          className="theme-toggle"
          onClick={() => setIsDark((previous) => !previous)}
          aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
        >
          {isDark ? "light" : "dark"}
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
        {notes.map((note) =>
          note.type === "model" ? (
            <ModelCard
              card={note}
              onVote={voteNote}
              onRemove={removeNote}
              key={note.id}
            />
          ) : (
            <article
              className="note"
              style={{ "--note-hue": note.color }}
              key={note.id}
            >
              <textarea
                className="note-text"
                value={note.text}
                placeholder="write something…"
                onChange={(event) => updateNote(note.id, event.target.value)}
                aria-label={`Note by ${note.author || "anonymous"}`}
              />
              <CardActions card={note} onVote={voteNote} onRemove={removeNote} />
            </article>
          ),
        )}

        <div className="add-control" ref={addControlRef}>
          {addMode && (
            <section
              className="add-panel"
              id="roomboard-add-panel"
              role="dialog"
              aria-label={addMode === "model" ? "Add a 3D model" : "Add to Roomboard"}
            >
              {addMode === "choices" ? (
                <>
                  <p className="add-panel-title">add to the board</p>
                  <div className="add-options">
                    <button type="button" className="add-option" onClick={addNote}>
                      <span className="add-option-icon note-icon" aria-hidden="true" />
                      <span>note</span>
                    </button>
                    <button
                      type="button"
                      className="add-option"
                      onClick={() => setAddMode("model")}
                    >
                      <span className="add-option-icon model-icon" aria-hidden="true">
                        3d
                      </span>
                      <span>3d model</span>
                    </button>
                  </div>
                </>
              ) : (
                <form className="model-form" onSubmit={submitModel} noValidate>
                  <div className="model-form-heading">
                    <button
                      type="button"
                      className="back-button"
                      onClick={() => {
                        setAddMode("choices");
                        setModelError("");
                      }}
                      aria-label="Back to add options"
                    >
                      ←
                    </button>
                    <div>
                      <label htmlFor="model-url">model url</label>
                      <p>.glb or .gltf</p>
                    </div>
                  </div>
                  <input
                    ref={modelInputRef}
                    id="model-url"
                    className="model-url-input"
                    type="url"
                    inputMode="url"
                    value={modelUrl}
                    onChange={(event) => {
                      setModelUrl(event.target.value);
                      setModelError("");
                    }}
                    placeholder="https://…/model.glb"
                    autoComplete="url"
                    aria-invalid={Boolean(modelError)}
                    aria-describedby={modelError ? "model-url-error" : "model-url-help"}
                  />
                  <p className="model-url-help" id="model-url-help">
                    paste a direct link to a glTF model.
                  </p>
                  {modelError && (
                    <p className="model-url-error" id="model-url-error" role="alert">
                      {modelError}
                    </p>
                  )}
                  <button type="submit" className="model-submit">
                    add model
                  </button>
                  <div className="sample-divider">
                    <span>or</span>
                  </div>
                  <button
                    type="button"
                    className="sample-button"
                    onClick={() => addModel(sampleModelUrl)}
                  >
                    <span className="sample-gem" aria-hidden="true">
                      ◇
                    </span>
                    use sample model
                    <span className="offline-chip">offline</span>
                  </button>
                </form>
              )}
            </section>
          )}

          <button
            ref={addButtonRef}
            type="button"
            className="note-add"
            onClick={() => {
              if (addMode) {
                closeAddPanel();
              } else {
                setAddMode("choices");
              }
            }}
            aria-label={addMode ? "Close add menu" : "Add a note or 3D model"}
            data-hint={
              addMode ? "close add menu" : "tap + to pin a note or 3d model"
            }
            aria-expanded={Boolean(addMode)}
            aria-controls="roomboard-add-panel"
          >
            <span className={addMode ? "add-plus is-open" : "add-plus"} aria-hidden="true">
              +
            </span>
          </button>
        </div>
      </main>

      <footer className="roomboard-footer">built live by ensemble.</footer>
    </div>
  );
}
