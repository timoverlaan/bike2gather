import { defineConfig, type Plugin } from 'vite';

/** Dev only: print log lines POSTed by the page (src/log.ts) in the terminal. */
function browserLog(): Plugin {
  return {
    name: 'browser-log',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__log', (req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const color = body.startsWith('ERROR') ? '\x1b[31m' : body.startsWith('WARN') ? '\x1b[33m' : '\x1b[36m';
          process.stdout.write(`${color}[browser]\x1b[0m ${body}\n`);
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

// Relative base so the build works on any GitHub Pages path (user or project site).
export default defineConfig({
  base: './',
  build: { target: 'es2020' },
  plugins: [browserLog()],
});
