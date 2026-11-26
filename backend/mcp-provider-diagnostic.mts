import { probeOAuthProvider } from './mcp-provider-readiness.mts';

// Only public discovery. No env/config files, tokens, login, user creation or DB access.
if (process.argv.length !== 4 || process.argv[2] !== '--issuer') {
  console.error('{"error":"expected_issuer_argument"}'); process.exitCode = 1;
} else {
  const result = await probeOAuthProvider(process.argv[3]);
  console.log(JSON.stringify(result));
  process.exitCode = !result.ok ? 1 : result.readiness.metadataCompatible ? 0 : 2;
}
