export default function App() {
  return (
    <div className="roomboard-shell">
      <header className="title-bar">
        <div className="brand-mark" aria-hidden="true">
          R
        </div>
        <div>
          <h1>Roomboard</h1>
          <p>A shared wall for the room</p>
        </div>
      </header>

      <main className="board" aria-label="Empty shared room board" />

      <footer className="roomboard-footer">built live by Ensemble.</footer>
    </div>
  );
}
