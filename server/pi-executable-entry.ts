// RpcClient launches `node <cliPath>`. Replace that process with the user's Pi
// executable so official shell launchers retain their environment setup, while
// the RPC client's PID, pipes and confirmed-stop semantics stay authoritative.
// A spawn/forwarding wrapper would leave Pi alive if the wrapper were SIGKILLed.
const executable = process.env.NOOKFRAME_PI_EXECUTABLE;
if (!executable || typeof process.execve !== 'function') throw new Error('Pi executable bridge requires NOOKFRAME_PI_EXECUTABLE and Node.js 24+ on POSIX');
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.NOOKFRAME_PI_EXECUTABLE;
process.execve(executable, [executable, ...process.argv.slice(2)], env);
