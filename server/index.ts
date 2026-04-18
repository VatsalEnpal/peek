// Stub — implemented in Group 6. Exports startServer for bin/peek.ts.
import express from 'express';

export async function startServer(opts: { port?: number } = {}): Promise<void> {
  const port = opts.port ?? 7334;
  const app = express();

  app.get('/api/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      version: '0.0.1',
      scaffold: true,
      note: 'Full server not implemented — Groups 6-14 build this.',
    });
  });

  app.listen(port, () => {
    console.log(`peek (scaffold) listening on http://localhost:${port}`);
  });
}
