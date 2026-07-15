import pino from "pino";
import { Page } from "rebrowser-playwright-core";

const logger = pino();

/**
 * Pause for a specified number of seconds.
 * @param x Minimum number of seconds.
 * @param y Maximum number of seconds (optional).
 */
export const sleep = (x: number, y?: number): Promise<void> => {
  let timeout = x * 1000;
  if (y !== undefined && y !== x) {
    const min = Math.min(x, y);
    const max = Math.max(x, y);
    timeout = Math.floor(Math.random() * (max - min + 1) + min) * 1000;
  }
  // console.log(`Sleeping for ${timeout / 1000} seconds`);
  logger.info(`Sleeping for ${timeout / 1000} seconds`);

  return new Promise(resolve => setTimeout(resolve, timeout));
}

/**
 * @param target A Locator or a page
 * @returns {boolean} 
 */
export const isPage = (target: any): target is Page => {
  return target.constructor.name === 'Page';
}

/**
 * Waits for an hCaptcha image requests and then waits for all of them to end
 * @param page
 * @param signal `const controller = new AbortController(); controller.status`
 * @returns {Promise<void>} 
 */
export const waitForRequests = (page: Page, signal: AbortSignal): Promise<void> => {
  return new Promise((resolve, reject) => {
    // Casa QUALQUER subdomínio do hCaptcha (img, imgs, newassets, assetscdn, ...).
    // O padrão antigo /img[a-zA-Z0-9]*\.hcaptcha\.com/ não pegava newassets.hcaptcha.com,
    // que é de onde o hCaptcha passou a servir os assets do desafio -> travava aqui.
    const urlPattern = /^https:\/\/[a-z0-9-]+\.hcaptcha\.com\/.*$/i;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let activeRequestCount = 0;
    let requestOccurred = false;

    const cleanupListeners = () => {
      page.off('request', onRequest);
      page.off('requestfinished', onRequestFinished);
      page.off('requestfailed', onRequestFinished);
    };

    const resetTimeout = () => {
      if (timeoutHandle)
        clearTimeout(timeoutHandle);
      if (activeRequestCount === 0) {
        timeoutHandle = setTimeout(() => {
          cleanupListeners();
          resolve();
        }, 1000); // 1 second of no requests
      }
    };

    const onRequest = (request: { url: () => string }) => {
      if (urlPattern.test(request.url())) {
        requestOccurred = true;
        activeRequestCount++;
        if (timeoutHandle)
          clearTimeout(timeoutHandle);
      }
    };

    const onRequestFinished = (request: { url: () => string }) => {
      if (urlPattern.test(request.url())) {
        activeRequestCount--;
        resetTimeout();
      }
    };

    // Wait for an hCaptcha request for up to 2 minutes
    const initialTimeout = setTimeout(() => {
      if (!requestOccurred) {
        page.off('request', onRequest);
        cleanupListeners();
        reject(new Error('No hCaptcha request occurred within 2 minutes.'));
      } else {
        // Start waiting for no hCaptcha requests
        resetTimeout();
      }
    }, 120000); // 2 minute timeout

    page.on('request', onRequest);
    page.on('requestfinished', onRequestFinished);
    page.on('requestfailed', onRequestFinished);

    // Cleanup the initial timeout if an hCaptcha request occurs
    page.on('request', (request: { url: () => string }) => {
      if (urlPattern.test(request.url())) {
        clearTimeout(initialTimeout);
      }
    });

    // TEMP DIAGNÓSTICO (remover depois de validar): loga toda requisição de captcha,
    // inclusive as que o regex NÃO casaria. Se aparecer '...hcaptcha.com...' aqui e o
    // captcha ainda falhar, o problema é o regex. Se NÃO aparecer nenhum captcha após
    // 'Triggering the CAPTCHA', o problema são os seletores da página /create.
    page.on('request', (request: { url: () => string }) => {
      const u = request.url();
      if (u.includes('hcaptcha') || u.includes('captcha'))
        logger.info('CAPTCHA-REQ ' + u);
    });

    const onAbort = () => {
      cleanupListeners();
      clearTimeout(initialTimeout);
      if (timeoutHandle)
        clearTimeout(timeoutHandle);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  }); 
}

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}
