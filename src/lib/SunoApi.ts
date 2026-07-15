  public async getCaptcha(): Promise<string|null> {
    if (!await this.captchaRequired())
      return null;

    logger.info('CAPTCHA required. Launching browser...')
    const browser = await this.launchBrowser();
    const page = await browser.newPage();
    await page.goto('https://suno.com/create', { referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: 0 });

    logger.info('Waiting for Suno interface to load');
    await page.waitForResponse('**/api/project/**\\?**', { timeout: 60000 }); // wait for song list API call

    if (this.ghostCursorEnabled)
      this.cursor = await createCursor(page);

    logger.info('Triggering the CAPTCHA');

    // ===================== TEMP DIAG (remover depois de descobrir a causa) =====================
    page.on('request', (r: any) => {
      const u = r.url();
      if (/hcaptcha|captcha|turnstile|challenges\.cloudflare|\/api\/generate/i.test(u))
        logger.info('DIAG-REQ ' + r.method() + ' ' + u);
    });
    page.on('response', (r: any) => {
      const u = r.url();
      if (/\/api\/generate\/v2|\/api\/c\/check|turnstile|hcaptcha/i.test(u))
        logger.info('DIAG-RESP ' + r.status() + ' ' + u);
    });
    // ==========================================================================================

    try {
      await page.getByLabel('Close').click({ timeout: 2000 }); // close all popups
    } catch(e) {}

    // New Suno UI (v5.5+): switch to "Advanced" (custom) mode to reveal the lyrics editor
    try {
      const advCount = await page.getByRole('tab', { name: 'Advanced' }).count();
      logger.info('DIAG Advanced-tab count=' + advCount);
      await page.getByRole('tab', { name: 'Advanced' }).click({ timeout: 5000 });
      logger.info('DIAG Advanced-tab clicked OK');
    } catch(e: any) { logger.info('DIAG Advanced-tab FAIL: ' + e.message); }

    const textarea = page.getByRole('textbox', { name: 'Lyrics editor' });
    logger.info('DIAG Lyrics-editor count=' + (await textarea.count()));
    try {
      await this.click(textarea);
      await textarea.pressSequentially('Lorem ipsum', { delay: 80 });
      logger.info('DIAG lyrics typed OK');
    } catch(e: any) { logger.info('DIAG lyrics typing FAIL: ' + e.message); }

    // Fill the Styles field too (required in the new UI), otherwise "Create song" stays disabled.
    try {
      const boxes = await page.getByRole('textbox').all();
      logger.info('DIAG total-textboxes=' + boxes.length);
      for (const b of boxes) {
        const nm = ((await b.getAttribute('aria-label')) || (await b.getAttribute('placeholder')) || '').toLowerCase();
        logger.info('DIAG textbox label="' + nm + '"');
        if (nm.includes('lyrics') || nm.includes('title')) continue;
        await this.click(b);
        await b.pressSequentially('children music, nursery rhyme', { delay: 50 });
      }
    } catch(e: any) { logger.info('DIAG styles-fill FAIL: ' + e.message); }

    const button = page.getByRole('button', { name: 'Create song' });
    logger.info('DIAG Create-song count=' + (await button.count()));
    try {
      logger.info('DIAG Create-song disabled=' + (await button.isDisabled({ timeout: 3000 })));
    } catch(e: any) { logger.info('DIAG isDisabled FAIL: ' + e.message); }
    this.click(button);
    logger.info('DIAG clicked Create-song');

    const controller = new AbortController();
    new Promise<void>(async (resolve, reject) => {
      const frame = page.frameLocator('iframe[title*="hCaptcha"]');
      const challenge = frame.locator('.challenge-container');
      try {
        let wait = true;
        while (true) {
          if (wait)
            await waitForRequests(page, controller.signal);
          const drag = (await challenge.locator('.prompt-text').first().innerText()).toLowerCase().includes('drag');
          let captcha: any;
          for (let j = 0; j < 3; j++) { // try several times because sometimes 2Captcha could return an error
            try {
              logger.info('Sending the CAPTCHA to 2Captcha');
              const payload: paramsCoordinates = {
                body: (await challenge.screenshot({ timeout: 5000 })).toString('base64'),
                lang: process.env.BROWSER_LOCALE
              };
              if (drag) {
                payload.textinstructions = 'CLICK on the shapes at their edge or center as shown above—please be precise!';
                payload.imginstructions = (await fs.readFile(path.join(process.cwd(), 'public', 'drag-instructions.jpg'))).toString('base64');
              }
              captcha = await this.solver.coordinates(payload);
              break;
            } catch(err: any) {
              logger.info(err.message);
              if (j != 2)
                logger.info('Retrying...');
              else
                throw err;
            }
          }
          if (drag) {
            const challengeBox = await challenge.boundingBox();
            if (challengeBox == null)
              throw new Error('.challenge-container boundingBox is null!');
            if (captcha.data.length % 2) {
              logger.info('Solution does not have even amount of points required for dragging. Requesting new solution...');
              this.solver.badReport(captcha.id);
              wait = false;
              continue;
            }
            for (let i = 0; i < captcha.data.length; i += 2) {
              const data1 = captcha.data[i];
              const data2 = captcha.data[i+1];
              logger.info(JSON.stringify(data1) + JSON.stringify(data2));
              await page.mouse.move(challengeBox.x + +data1.x, challengeBox.y + +data1.y);
              await page.mouse.down();
              await sleep(1.1); // wait for the piece to be 'unlocked'
              await page.mouse.move(challengeBox.x + +data2.x, challengeBox.y + +data2.y, { steps: 30 });
              await page.mouse.up();
            }
            wait = true;
          } else {
            for (const data of captcha.data) {
              logger.info(data);
              await this.click(challenge, { x: +data.x, y: +data.y });
            };
          }
          this.click(frame.locator('.button-submit')).catch(e => {
            if (e.message.includes('viewport')) // when hCaptcha window has been closed due to inactivity,
              this.click(button); // click the Create button again to trigger the CAPTCHA
            else
              throw e;
          });
        }
      } catch(e: any) {
        if (e.message.includes('been closed') // catch error when closing the browser
          || e.message == 'AbortError') // catch error when waitForRequests is aborted
          resolve();
        else
          reject(e);
      }
    }).catch(e => {
      browser.browser()?.close();
      throw e;
    });
    return (new Promise((resolve, reject) => {
      page.route('**/api/generate/v2/**', async (route: any) => {
        try {
          logger.info('hCaptcha token received. Closing browser');
          route.abort();
          browser.browser()?.close();
          controller.abort();
          const request = route.request();
          this.currentToken = request.headers().authorization.split('Bearer ').pop();
          resolve(request.postDataJSON().token);
        } catch(err) {
          reject(err);
        }
      });
    }));
  }
