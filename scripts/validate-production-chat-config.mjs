const endpoints = (process.env.VITE_MARMOT_RELAYS ?? '')
  .split(',')
  .map((endpoint) => endpoint.trim())
  .filter(Boolean);

if (endpoints.length < 1 || endpoints.length > 8) {
  throw new Error(
    'Production chat requires 1–8 comma-separated VITE_MARMOT_RELAYS.',
  );
}

for (const endpoint of endpoints) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid Marmot relay URL: ${endpoint}`);
  }
  if (url.protocol !== 'wss:') {
    throw new Error(`Production Marmot relays must use wss://: ${endpoint}`);
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      `Production Marmot relay URLs cannot contain credentials, queries, or fragments: ${endpoint}`,
    );
  }
}
