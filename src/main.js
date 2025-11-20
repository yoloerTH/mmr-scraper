import { Actor } from 'apify';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Add stealth plugin
chromium.use(StealthPlugin());

// ============================================
// HUMAN-LIKE BEHAVIOR HELPERS
// ============================================

async function humanDelay(min = 1000, max = 3000) {
    const delay = Math.random() * (max - min) + min;
    await new Promise(resolve => setTimeout(resolve, delay));
}

async function simulateHumanMouse(page) {
    const x = Math.floor(Math.random() * 500) + 100;
    const y = Math.floor(Math.random() * 500) + 100;

    await page.mouse.move(x, y, { steps: 10 });
    await humanDelay(300, 800);
}

async function simulateHumanScroll(page) {
    const scrollAmount = Math.floor(Math.random() * 300) + 200;
    await page.evaluate((amount) => {
        window.scrollBy({
            top: amount,
            behavior: 'smooth'
        });
    }, scrollAmount);
    await humanDelay(500, 1000);
}

async function humanTypeVIN(page, selector, vin) {
    // Focus input
    await page.click(selector);
    await humanDelay(300, 600);

    // Type character by character with random delays
    for (const char of vin) {
        await page.keyboard.type(char);
        await humanDelay(80, 200); // Random typing speed
    }

    await humanDelay(500, 1000);
}

// ============================================
// MMR EXTRACTION FUNCTIONS
// ============================================

async function extractMMRValues(page) {
    console.log('📊 Extracting MMR values from page...');

    const mmrData = await page.evaluate(() => {
        // Helper function to extract number from price string
        const extractPrice = (text) => {
            if (!text) return null;
            const match = text.match(/\$[\d,]+/);
            if (!match) return null;
            return parseInt(match[0].replace(/[$,]/g, ''));
        };

        // Extract Base MMR (36px font, inside baseMMRTitle container)
        const baseMmrEl = document.querySelector('.styles__baseMMRTitle__AfQgP .styles__currency__EkR32');
        const baseMmrText = baseMmrEl?.textContent?.trim();

        // Extract Adjusted MMR (44px font, inside adjustedMMRContainer)
        const adjustedMmrEl = document.querySelector('.styles__adjustedMMRContainer__lixDF .styles__currency__EkR32');
        const adjustedMmrText = adjustedMmrEl?.textContent?.trim();

        // Extract MMR Range ($36,700 - $40,300)
        const mmrRangeEl = document.querySelector('.styles__adjMMRRangeValue__fOTt5');
        const mmrRangeText = mmrRangeEl?.textContent?.trim();

        // Extract Estimated Retail Value
        const retailEl = document.querySelector('.styles__estimatedRetailValue__Wkxa3');
        const retailText = retailEl?.textContent?.trim();

        // Extract Typical Range (for retail)
        const typicalRangeEl = document.querySelector('.styles__adjTypicalRangeValue__rwVzw');
        const typicalRangeText = typicalRangeEl?.textContent?.trim();

        // Parse MMR Range into min and max
        let mmrRangeMin = null;
        let mmrRangeMax = null;
        if (mmrRangeText) {
            const prices = mmrRangeText.match(/\$[\d,]+/g);
            if (prices && prices.length >= 2) {
                mmrRangeMin = parseInt(prices[0].replace(/[$,]/g, ''));
                mmrRangeMax = parseInt(prices[1].replace(/[$,]/g, ''));
            }
        }

        return {
            mmr_base_usd: extractPrice(baseMmrText),
            mmr_adjusted_usd: extractPrice(adjustedMmrText),
            mmr_range_min_usd: mmrRangeMin,
            mmr_range_max_usd: mmrRangeMax,
            estimated_retail_usd: extractPrice(retailText),
            raw_data: {
                base_mmr_text: baseMmrText,
                adjusted_mmr_text: adjustedMmrText,
                mmr_range_text: mmrRangeText,
                retail_text: retailText,
                typical_range_text: typicalRangeText
            }
        };
    });

    console.log('  Base MMR (USD):', mmrData.mmr_base_usd || 'NOT FOUND');
    console.log('  Adjusted MMR (USD):', mmrData.mmr_adjusted_usd || 'NOT FOUND');
    console.log('  MMR Range:', `$${mmrData.mmr_range_min_usd || '?'} - $${mmrData.mmr_range_max_usd || '?'}`);
    console.log('  Estimated Retail (USD):', mmrData.estimated_retail_usd || 'NOT FOUND');

    return mmrData;
}

// ============================================
// MAIN SCRAPER
// ============================================

await Actor.main(async () => {
    const input = await Actor.getInput();

    const {
        manheimCookies = [],
        supabaseEdgeFunctionUrl = 'https://nyhpgaksdlmrclraqqmg.supabase.co/functions/v1/get-next-vin',
        n8nWebhookUrl = '',
        maxVINsPerRun = 100,
        delayBetweenVINs = [3000, 8000] // [min, max] in milliseconds
    } = input;

    console.log('🚀 Starting Manheim MMR Scraper...');
    console.log(`📊 Max VINs per run: ${maxVINsPerRun}`);
    console.log(`⏱️ Delay between VINs: ${delayBetweenVINs[0]/1000}s - ${delayBetweenVINs[1]/1000}s`);

    // Validate inputs
    if (!manheimCookies || manheimCookies.length === 0) {
        throw new Error('❌ manheimCookies is required! Please provide your Manheim session cookies.');
    }

    if (!n8nWebhookUrl) {
        throw new Error('❌ n8nWebhookUrl is required! Please provide your n8n webhook URL.');
    }

    // Launch browser with stealth
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-web-security',
        ],
    });

    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });

    // Set default navigation timeout
    context.setDefaultNavigationTimeout(90000);

    // Inject cookies BEFORE navigating
    console.log('🍪 Injecting session cookies...');
    await context.addCookies(manheimCookies);

    const page = await context.newPage();

    try {
        // STEP 1: Verify login by visiting Manheim home
        console.log('\n🌐 Verifying Manheim session...');
        await page.goto('https://home.manheim.com/landingPage#/', {
            waitUntil: 'domcontentloaded',
            timeout: 90000
        });

        await humanDelay(3000, 5000);
        await simulateHumanMouse(page);

        // Check if we're logged in (look for MMR button or user info)
        const isLoggedIn = await page.evaluate(() => {
            const mmrButton = document.querySelector('[data-test-id="mmr-btn"]');
            return mmrButton !== null;
        });

        if (!isLoggedIn) {
            console.error('❌ Login verification failed! Session cookies may be expired.');
            console.error('Please extract fresh cookies from your browser and update the input.');
            throw new Error('Session authentication failed - cookies expired or invalid');
        }

        console.log('✅ Session verified! Logged into Manheim successfully.');

        // STEP 2: Click MMR button to open MMR tool
        console.log('\n📊 Opening MMR tool...');
        await simulateHumanMouse(page);
        await humanDelay(1000, 2000);

        // Click MMR button
        const mmrButton = page.locator('[data-test-id="mmr-btn"]');
        await mmrButton.click({ timeout: 30000 });

        console.log('✅ MMR tool opened');
        await humanDelay(3000, 5000);

        // MMR tool opens in a new window/tab - wait for it
        const mmrPagePromise = context.waitForEvent('page');
        const mmrPage = await mmrPagePromise;
        await mmrPage.waitForLoadState('domcontentloaded');
        await humanDelay(2000, 4000);

        console.log('✅ MMR page loaded');

        // STEP 3: Process VINs from Supabase
        let vinsProcessed = 0;
        let vinsSuccessful = 0;
        let vinsFailed = 0;

        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔄 Starting VIN processing loop (max: ${maxVINsPerRun})`);
        console.log(`${'='.repeat(60)}\n`);

        while (vinsProcessed < maxVINsPerRun) {
            try {
                // Get next VIN from Supabase
                console.log(`\n📞 Fetching VIN #${vinsProcessed + 1} from Supabase...`);
                const vinResponse = await fetch(supabaseEdgeFunctionUrl);
                const vinData = await vinResponse.json();

                if (!vinData.success || !vinData.data) {
                    console.log('✅ No more pending VINs. Scraping complete!');
                    break;
                }

                const {
                    id: listing_id,
                    vin,
                    cargurus_price_cad,
                    cargurus_mileage_km,
                    mileage_miles
                } = vinData.data;

                console.log(`\n${'='.repeat(60)}`);
                console.log(`🚗 Processing VIN #${vinsProcessed + 1}: ${vin}`);
                console.log(`📍 Listing ID: ${listing_id}`);
                console.log(`💰 CarGurus Price: $${cargurus_price_cad} CAD`);
                console.log(`🛣️ Mileage: ${cargurus_mileage_km} km (${mileage_miles} mi)`);
                console.log(`${'='.repeat(60)}\n`);

                // STEP 4: Input VIN and search
                await simulateHumanMouse(mmrPage);
                await humanDelay(1000, 2000);

                // Clear existing input if any
                const vinInput = mmrPage.locator('#vinText');
                await vinInput.clear();
                await humanDelay(300, 600);

                // Type VIN human-like
                console.log('⌨️ Typing VIN...');
                await humanTypeVIN(mmrPage, '#vinText', vin);

                // Click search button
                console.log('🔍 Clicking search button...');
                await simulateHumanMouse(mmrPage);
                const searchButton = mmrPage.locator('button[aria-label="Search VIN"]');
                await searchButton.click({ timeout: 30000 });

                // Wait for results to load
                console.log('⏳ Waiting for MMR results...');
                await humanDelay(4000, 7000);

                // Check if VIN was found
                const vinNotFound = await mmrPage.evaluate(() => {
                    const errorText = document.body.textContent.toLowerCase();
                    return errorText.includes('no data found') ||
                           errorText.includes('vin not found') ||
                           errorText.includes('invalid vin');
                });

                if (vinNotFound) {
                    console.log('⚠️ VIN not found in MMR database');

                    // Send to webhook with status
                    await fetch(n8nWebhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            listing_id,
                            vin,
                            cargurus_price_cad,
                            cargurus_mileage_km,
                            mileage_miles,
                            mmr_status: 'vin_not_found',
                            error: 'VIN not found in MMR database'
                        })
                    });

                    vinsFailed++;
                    vinsProcessed++;
                    continue;
                }

                // STEP 5: Input mileage to get adjusted MMR
                console.log(`📏 Inputting mileage: ${mileage_miles} miles...`);

                // Wait for odometer field to appear
                await mmrPage.waitForSelector('#Odometer', { timeout: 10000 });
                await humanDelay(1000, 2000);

                // Click the input field
                const odometerInput = mmrPage.locator('#Odometer');
                await odometerInput.click();
                await humanDelay(300, 600);

                // Clear any existing value
                await odometerInput.fill('');
                await humanDelay(300, 600);

                // Type mileage character by character (human-like)
                console.log('⌨️ Typing mileage...');
                for (const char of mileage_miles.toString()) {
                    await mmrPage.keyboard.type(char);
                    await humanDelay(80, 200);
                }

                // Click the submit button (checkmark icon)
                console.log('✅ Submitting mileage...');
                const submitButton = mmrPage.locator('button[aria-label="Submit odo"]');
                await submitButton.click();

                // Wait for MMR to recalculate with adjusted mileage
                console.log('⏳ Waiting for MMR to recalculate...');
                await humanDelay(4000, 6000);

                // STEP 6: Extract MMR values (now adjusted for mileage)
                const mmrValues = await extractMMRValues(mmrPage);

                // Validate that we got data
                if (!mmrValues.mmr_base_usd) {
                    console.log('⚠️ Failed to extract MMR values');
                    vinsFailed++;
                    vinsProcessed++;
                    continue;
                }

                // STEP 7: Send to n8n webhook
                console.log('\n📤 Sending data to n8n webhook...');
                const webhookPayload = {
                    listing_id,
                    vin,
                    mmr_base_usd: mmrValues.mmr_base_usd,
                    mmr_adjusted_usd: mmrValues.mmr_adjusted_usd,
                    mmr_range_min_usd: mmrValues.mmr_range_min_usd,
                    mmr_range_max_usd: mmrValues.mmr_range_max_usd,
                    estimated_retail_usd: mmrValues.estimated_retail_usd,
                    cargurus_price_cad,
                    cargurus_mileage_km,
                    mileage_miles
                };

                const webhookResponse = await fetch(n8nWebhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(webhookPayload)
                });

                if (webhookResponse.ok) {
                    console.log(`✅ Webhook sent successfully (${webhookResponse.status})`);
                    vinsSuccessful++;
                } else {
                    console.log(`⚠️ Webhook failed (${webhookResponse.status})`);
                    vinsFailed++;
                }

                vinsProcessed++;

                // Human-like delay between VINs
                if (vinsProcessed < maxVINsPerRun) {
                    const delayTime = Math.random() * (delayBetweenVINs[1] - delayBetweenVINs[0]) + delayBetweenVINs[0];
                    console.log(`\n⏸️ Waiting ${(delayTime/1000).toFixed(1)}s before next VIN...`);
                    await humanDelay(delayTime, delayTime + 1000);

                    // Simulate some human activity during wait
                    await simulateHumanScroll(mmrPage);
                    await simulateHumanMouse(mmrPage);
                }

            } catch (vinError) {
                console.error(`❌ Error processing VIN:`, vinError.message);
                vinsFailed++;
                vinsProcessed++;

                // Continue to next VIN even if one fails
                await humanDelay(3000, 5000);
            }
        }

        // STEP 8: Summary
        console.log(`\n${'='.repeat(60)}`);
        console.log('📊 SCRAPING SUMMARY');
        console.log(`${'='.repeat(60)}`);
        console.log(`✅ Total VINs processed: ${vinsProcessed}`);
        console.log(`✅ Successful: ${vinsSuccessful}`);
        console.log(`❌ Failed: ${vinsFailed}`);
        console.log(`${'='.repeat(60)}\n`);

    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        throw error;
    }

    await browser.close();
    console.log('✅ Scraper completed successfully!');
});
