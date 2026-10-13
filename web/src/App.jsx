import { useCallback, useEffect, useState } from 'react';

// All calls use relative URLs: in Docker the nginx proxy sends /api/* to the API.
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  // /api/health answers 503 with a useful body when a dependency is down
  if (!res.ok && res.status !== 503) {
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return body;
}

function StatusRow({ name, role, state }) {
  const label = state === 'up' ? 'Running' : state === 'down' ? 'Down' : 'Checking';
  return (
    <li className="status-row">
      <span className={`dot dot-${state}`} aria-hidden="true" />
      <span className="status-name">{name}</span>
      <span className="status-role">{role}</span>
      <span className={`status-label label-${state}`}>{label}</span>
    </li>
  );
}

export default function App() {
  const [health, setHealth] = useState(null); // { api, mongo, redis }
  const [visits, setVisits] = useState(null);
  const [notes, setNotes] = useState([]);
  const [source, setSource] = useState(null); // 'cache' | 'database'
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadHealth = useCallback(async () => {
    try {
      const h = await api('/health');
      setHealth({ api: 'up', mongo: h.mongo, redis: h.redis });
    } catch {
      setHealth({ api: 'down', mongo: 'unknown', redis: 'unknown' });
    }
  }, []);

  const loadNotes = useCallback(async () => {
    try {
      const data = await api('/notes');
      setNotes(data.notes);
      setSource(data.source);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadHealth();
    loadNotes();
    api('/visits').then((d) => setVisits(d.visits)).catch(() => {});
    const timer = setInterval(loadHealth, 10000);
    return () => clearInterval(timer);
  }, [loadHealth, loadNotes]);

  async function addNote(event) {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api('/notes', { method: 'POST', body: JSON.stringify({ text }) });
      setText('');
      await loadNotes();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeNote(id) {
    try {
      await api(`/notes/${id}`, { method: 'DELETE' });
      await loadNotes();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <main className="page">
      <header className="masthead">
        <h1>Stack notes</h1>
        <p>
          Every note you save travels through five containers. Reload the page to see Redis answer
          instead of MongoDB.
        </p>
      </header>

      <div className="layout">
        <section className="panel" aria-labelledby="notes-title">
          <h2 id="notes-title">Notes</h2>

          <form className="composer" onSubmit={addNote}>
            <label htmlFor="note-text" className="visually-hidden">
              New note
            </label>
            <input
              id="note-text"
              value={text}
              maxLength={200}
              placeholder="Write a note and save it to MongoDB"
              onChange={(e) => setText(e.target.value)}
            />
            <button type="submit" disabled={busy || !text.trim()}>
              Save note
            </button>
          </form>

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          {source && (
            <p className={`source source-${source}`}>
              {source === 'cache'
                ? 'This list came from the Redis cache.'
                : 'This list was read from MongoDB and is now cached for 30 seconds.'}
            </p>
          )}

          {notes.length === 0 ? (
            <p className="empty">No notes yet. Save one above to write it to the database.</p>
          ) : (
            <ul className="notes">
              {notes.map((n) => (
                <li key={n.id}>
                  <div>
                    <span className="note-text">{n.text}</span>
                    <time dateTime={n.createdAt}>{new Date(n.createdAt).toLocaleString()}</time>
                  </div>
                  <button className="link" onClick={() => removeNote(n.id)} aria-label={`Delete note: ${n.text}`}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="panel" aria-labelledby="stack-title">
          <h2 id="stack-title">Stack health</h2>
          <ul className="status">
            <StatusRow name="api" role="Express" state={health?.api ?? 'checking'} />
            <StatusRow name="mongo" role="Database" state={health?.mongo ?? 'checking'} />
            <StatusRow name="redis" role="Cache" state={health?.redis ?? 'checking'} />
          </ul>
          <p className="visits">
            <strong>{visits ?? '–'}</strong> page loads counted in Redis
          </p>
        </aside>
      </div>
    </main>
  );
}
