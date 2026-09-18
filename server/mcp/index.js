// Entry point for `drcompass mcp`.
//
// Launched by an MCP client as a bare child process: no TTY, no terminal, stdin
// and stdout are pipes carrying protocol frames and nothing else. Everything
// this file prints goes to stderr, which is where a client's MCP log reads from.
import { McpServer } from './server.js';
import { log } from './stdio.js';

/**
 * @param {{allowWrites?: boolean}} opts
 */
export async function startMcp(opts = {}) {
  // The env var is the form an MCP client config can express, since a client
  // spawns a fixed command line from JSON. Either turns writes on.
  const on = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));
  const allowWrites = !!opts.allowWrites || on(process.env.DRCOMPASS_MCP_ALLOW_WRITES);
  // A separate switch on purpose: "change my plan" and "spawn a second AI over
  // my plan" are different risks and a user may well want one without the other.
  const allowAiCli = !!opts.allowAiCli || on(process.env.DRCOMPASS_MCP_ALLOW_AI_CLI);

  // NOT SEEDED. `drcompass start` copies the bundled example workspace on first
  // run, and the first version of this file did the same for parity. It was
  // wrong twice over.
  //
  // First, it contradicts the rule the rest of this server is built on — that it
  // never creates state nobody asked for. A client launches this in the
  // background; writing thirteen JSON files into somebody's ~/.drcompass because
  // a chat session happened to start is exactly the surprise that rule exists to
  // prevent, and a read-only server doing it is worse.
  //
  // Second, and this one is about the product's own thesis: the example
  // workspace is FICTION. It is a plausible, detailed, entirely invented DR plan
  // for a pharmacy claims platform. A human opening it in the UI has clicked
  // something called "example"; a model that finds it in `list_workspaces` has
  // no such context, and a tool whose reason for existing is to stop invented
  // numbers being read as real should not invent a whole workspace.
  //
  // So an empty installation answers honestly: no workspaces, and here is how to
  // make one. See the `list_workspaces` tool.

  const server = new McpServer({ allowWrites, allowAiCli });
  await server.start();

  // A client kills the child when the session ends; exit cleanly and take the
  // private socket with us.
  const bye = async (signal) => {
    log(`received ${signal}, shutting down`);
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => { bye('SIGINT'); });
  process.on('SIGTERM', () => { bye('SIGTERM'); });
  process.stdin.on('close', () => { bye('stdin close'); });

  // A broken pipe means the client is gone. There is nothing left to serve and
  // nowhere to report it, so go — the client respawns us next time. Without
  // this, an EPIPE surfaces as an uncaught exception and the handler below
  // tries to log it, which is the loop described in stdio.js.
  for (const s of [process.stdout, process.stderr]) {
    s.on?.('error', (e) => {
      if (e && (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED')) process.exit(0);
    });
  }

  // ORPHANED: the client died without closing the pipe it held open.
  //
  // `stdin.on('close')` never fires in that case — the write end is still open
  // in a dead parent's fd table — so nothing above notices and the process
  // lives forever. A force-quit of an MCP client leaves exactly this behind,
  // and it used to spin a CPU core indefinitely. On POSIX an orphan is
  // reparented to init, so ppid becoming 1 is the signal. Checked rarely and
  // unref()'d, so the timer itself can never be the reason we stay alive.
  const startPpid = process.ppid;
  if (process.platform !== 'win32' && startPpid > 1) {
    const orphanCheck = setInterval(() => {
      if (process.ppid !== startPpid || process.ppid <= 1) {
        log(`parent ${startPpid} is gone — exiting rather than lingering`);
        server.stop().finally(() => process.exit(0));
      }
    }, 5000);
    orphanCheck.unref?.();
  }

  // AN UNCAUGHT EXCEPTION IS FATAL. This used to say "log it and keep serving,
  // because the client has no other way to learn what happened", and that
  // sentence is how the orphan above became an infinite loop instead of a clean
  // death: the handler logged, the log threw EPIPE, the throw re-entered the
  // handler, forever.
  //
  // The latch in stdio.js stops the loop, but the policy was wrong on its own
  // terms too. "Keep serving" is right for an error caught AT THE CALL SITE —
  // a bad tool argument, an unknown workspace, a malformed frame — and every
  // one of those is already handled there: `callTool()` turns any throw into an
  // `isError` result and `#dispatch()` turns any handler throw into a JSON-RPC
  // error, so nothing routine ever reaches this handler. What reaches it is a
  // genuine crash of unknown extent, usually a dead transport, and a server
  // that cannot write to its own transport has nothing left to serve. Going is
  // both correct and kinder: the client respawns us on the next request, where
  // limping on would answer with a process whose state nobody can vouch for.
  process.on('uncaughtException', (e) => {
    log('uncaught exception — exiting:', e && e.stack ? e.stack : String(e));
    try { server.stop(); } catch { /* going anyway */ }
    process.exit(1);
  });
  // A rejection nobody handled is a bug worth printing, but it has not
  // necessarily broken anything, and killing a live session over one would
  // throw away whatever the user was in the middle of. This keeps the old
  // policy deliberately.
  process.on('unhandledRejection', (e) => { log('unhandled rejection:', e && e.stack ? e.stack : String(e)); });

  return server;
}
