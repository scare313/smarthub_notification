async function setupInterception(page, targetUrlPart) {
  let interceptedData = null;

  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (url.includes(targetUrlPart)) {
        console.log(`[Network Interceptor] Intercepted response for: ${url}`);
        const contentType = response.headers()['content-type'] || '';
        if (contentType.includes('application/json')) {
          interceptedData = await response.json();
        }
      }
    } catch (err) {
      // Ignore reading errors for empty or preflight responses
    }
  });

  return {
    getData: () => interceptedData
  };
}

module.exports = { setupInterception };
