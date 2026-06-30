// StockVizor — Research Images Auto-Generator
// Deploy as: generate-research-images (--no-verify-jwt)
//
// Triggered automatically (fire-and-forget) after a research report is upserted.
// Handles the full image generation pipeline end-to-end:
//   1. Fetch report from DB → build contextual Leonardo prompt
//   2. Call Leonardo AI directly → get generationId
//   3. Poll until COMPLETE (max 25 polls × 5s = 125s)
//   4. Download Leonardo CDN images → upload to Supabase Storage (research-images bucket)
//   5. PATCH report row with images array [ { url, alt }, ... ]
//
// URL params:
//   ?type=macro   &report_date=YYYY-MM-DD
//   ?type=sector  &report_date=YYYY-MM-DD  &sector=technology
//   ?type=stock   &report_date=YYYY-MM-DD  &ticker=AAPL

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://hkamukkkkpqhdpcradau.supabase.co';
const SUPA_SVC     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const LEO_KEY      = Deno.env.get('LEONARDO_API_KEY') ?? '';
const BUCKET       = 'research-images';

// ── Prompt builder ────────────────────────────────────────────────────────────

const PHOTO_BASE = ', editorial photography, natural lighting, sharp focus, photojournalism quality, no text, no watermarks, 16:9';

// Extracts the single most relevant visual subject from a report's text content.
// Checks keywords from the title + summary so each image reflects the actual topic,
// not a static company or sector mapping.
function extractSubject(text: string, ticker: string): string {
  const t = text.toLowerCase();

  // ── Stock price / technical action — checked first, most common report type ─
  // Covers momentum, RSI, pullbacks, support/resistance, breakouts, sell signals.
  if (/sell.signal|buy.signal|rsi.(?:caution|divergen|overbought|oversold)/.test(t))
    return 'close-up of stock chart on trading terminal showing RSI indicator and price signals, technical analysis screen, financial data';
  if (/pullback.from.high|retreat.from.peak|slides?.from.peak|fades?.into.consolidation|momentum.cool|momentum.fad|momentum.stall/.test(t))
    return 'stock market analyst at trading desk watching red declining price chart on monitor, portfolio pullback, financial data screen';
  if (/overbought|52.week.high|near.peak|at.peak|at.high|from.high|momentum.divergen/.test(t))
    return 'stock price chart on computer screen showing overextended price with analyst pointing at divergence, trading terminal, professional environment';
  if (/support.hold|watch.*support|\$\d+ support|key support|support level/.test(t))
    return 'trader monitoring stock price approaching support level on dual-screen trading setup, candlestick chart, professional office';
  if (/breakout|breaks? out|breaking higher|bullish setup|momentum build/.test(t))
    return 'stock price chart showing breakout above resistance on trading monitor, rising candlesticks, analyst at work';
  if (/consolidat|sideways|range.bound|coiling/.test(t))
    return 'stock chart in sideways consolidation pattern on trading terminal, narrow price range, analyst studying chart';
  if (/slides?|drops?|falls?|decline|down \d+%|down \d+ percent|loses?|loss/.test(t))
    return 'financial professional watching falling stock price chart on multiple screens, market decline, trading room environment';
  if (/rallies?|surges?|gains?|up \d+%|jumps?|rises?|climbs?|soars?/.test(t))
    return 'stock market professional watching rising green price chart on trading monitors, market rally, positive market data';
  if (/short.interest|short.squeeze|short.seller/.test(t))
    return 'trader studying short interest data on multiple screens, market analytics, professional trading environment';
  if (/volatility|vix|implied.vol|options.flow/.test(t))
    return 'options trader at desk with volatility charts on screens, derivatives market data, professional trading floor';

  // ── Specific technologies / products ──────────────────────────────────────
  if (/humanoid|optimus robot|robot worker|bipedal/.test(t))
    return 'humanoid robot on factory floor being tested by engineers, robotics technology, industrial setting';
  if (/self.driving|robotaxi|autonomous vehicle|driverless|full self.driving/.test(t))
    return 'autonomous vehicle on urban street, sensor array on roof, self-driving car technology';
  if (/supercharger|ev.charging|electric.vehicle.charging|charging.station/.test(t))
    return 'electric vehicles charging at a Supercharger station at dusk, EV infrastructure';
  if (/vr.headset|virtual.reality|augmented.reality|quest.headset|mixed.reality/.test(t))
    return 'person wearing VR headset with hand controllers, immersive virtual reality experience';
  if (/h100|b200|blackwell|hopper|gpu.cluster|gpu.server|nvidia.chip/.test(t))
    return 'rows of NVIDIA GPU server blades in data center, green LED indicators, high-performance AI compute';
  if (/hbm|high.bandwidth.memory|dram.pric|memory.pricing|nand.flash/.test(t))
    return 'close-up of DRAM memory modules on circuit board, macro photography, semiconductor components';
  if (/wafer|foundry|fab |fabrication|lithography|18a|process.node|yield.issue/.test(t))
    return 'engineer in cleanroom suit holding silicon wafer under bright overhead light, semiconductor fab';
  if (/snapdragon|mobile.chip|smartphone.chip|arm.chip/.test(t))
    return 'smartphone circuit board close-up, mobile processor chip, electronics macro photography';
  if (/asml|euv|extreme.ultraviolet/.test(t))
    return 'extreme ultraviolet lithography machine in semiconductor cleanroom, precision optics, advanced manufacturing';

  // ── AI / compute themes ───────────────────────────────────────────────────
  if (/large.language.model|llm|generative.ai|gpt|gemini|claude|chatbot/.test(t))
    return 'AI researcher at computer workstation with code on screen, machine learning lab environment';
  if (/artificial.intelligence|machine.learning|ai.inference|ai.training/.test(t))
    return 'hyperscale AI data center corridor, server racks with blue LED lighting, compute infrastructure';
  if (/data.center|cloud.infra|cloud.revenue|colocation|server.capacity/.test(t))
    return 'data center server corridor, cable-managed racks, engineers at work, enterprise infrastructure';
  if (/aws|azure|google.cloud|cloud.platform|cloud.services/.test(t))
    return 'cloud computing data center exterior, modern tech campus, large-scale server infrastructure';

  // ── Consumer / social ─────────────────────────────────────────────────────
  if (/instagram|reels|tiktok|social.media.platform|content.creator/.test(t))
    return 'content creator filming with smartphone and ring light, social media studio, digital influencer';
  if (/metaverse|horizon.worlds|social.vr/.test(t))
    return 'person using VR headset at home, virtual social environment, immersive digital experience';
  if (/advertising|ad.revenue|digital.ads|programmatic|ad.spend/.test(t))
    return 'digital advertising screens in busy urban setting, online marketing, commercial displays';
  if (/search|google.search|search.engine|search.ai/.test(t))
    return 'person typing search query on laptop, digital information retrieval, modern browsing';
  if (/streaming|subscriber|content.platform|video.platform/.test(t))
    return 'person watching streaming content on large TV in living room, entertainment technology';
  if (/e.commerce|online.shopping|digital.retail|marketplace/.test(t))
    return 'person ordering online on tablet, e-commerce shopping experience, digital commerce';
  if (/fulfillment|warehouse|logistics|delivery|supply.chain|package/.test(t))
    return 'Amazon-style fulfillment center workers on conveyor belt floor, logistics operations';

  // ── Macro / monetary ─────────────────────────────────────────────────────
  if (/federal.reserve|fomc|powell|central.bank/.test(t))
    return 'Federal Reserve building exterior in Washington DC, central bank, monetary policy headquarters';
  if (/bond.yield|treasury.yield|10.year|2.year|rate.hike|rate.cut|interest.rate/.test(t))
    return 'bond trading floor with analysts at terminals, fixed income market, financial data screens';
  if (/inflation|cpi|pce|consumer.price.index/.test(t))
    return 'supermarket shopper examining price tag, rising consumer prices, retail inflation concept';
  if (/gdp|economic.growth|recession|contraction/.test(t))
    return 'economist presenting chart to business audience, economic analysis, financial briefing';
  if (/dollar|currency|forex|exchange.rate|yen|euro/.test(t))
    return 'currency trading screens with live forex data, financial trading room, multiple monitors';
  if (/stock.market|wall.street|equity.market|market.rally|market.selloff/.test(t))
    return 'New York Stock Exchange trading floor, brokers at screens, active market session';
  if (/tariff|trade.war|import|export|sanctions/.test(t))
    return 'cargo containers at busy port, international shipping, global trade logistics';

  // ── Sector-specific ───────────────────────────────────────────────────────
  if (/oil|crude.oil|brent|wti|opec|petroleum|refin/.test(t))
    return 'oil refinery at dusk with flare stacks, petrochemical processing plant, energy infrastructure';
  if (/solar|wind.turbin|renewable|clean.energy/.test(t))
    return 'wind turbine farm at sunrise with blue sky, clean energy infrastructure, sustainable power';
  if (/nuclear|reactor|energy.transition|power.grid/.test(t))
    return 'electrical power grid substation at dusk, high-voltage transformers, energy distribution';
  if (/pharma|drug.approval|fda|clinical.trial|vaccine|oncology|biotech/.test(t))
    return 'pharmaceutical lab researcher pipetting samples into vials, drug development, medical research';
  if (/hospital|healthcare|patient|surgical|ehr|insurance.claim/.test(t))
    return 'hospital corridor with healthcare workers, modern medical facility, clinical environment';
  if (/aircraft|aviation|aerospace|boeing|airbus/.test(t))
    return 'commercial aircraft on airport tarmac during maintenance check, aviation engineering';
  if (/construction|infrastructure|real.estate|reit|property/.test(t))
    return 'construction site with cranes and steel framework, urban infrastructure development';
  if (/retail.store|brick.and.mortar|same.store|foot.traffic/.test(t))
    return 'busy retail store interior, shoppers browsing merchandise, consumer spending activity';
  if (/bank|lending|credit|loan|deposit|interest.income/.test(t))
    return 'bank branch interior, financial advisor meeting with client, professional banking services';
  if (/semiconductor|microchip|chip.demand|chip.supply/.test(t))
    return 'semiconductor chip wafer on inspection table, microprocessor manufacturing, cleanroom';
  if (/earnings|revenue.beat|eps|profit.miss|guidance/.test(t))
    return 'financial analyst reviewing stock charts on dual monitors, trading desk, market data';
  if (/electric.vehicle|ev.market|ev.sales|battery.range/.test(t))
    return 'electric vehicle on open highway, clean transportation, sustainable mobility';
  if (/cybersecurity|data.breach|hack|ransomware|zero.day/.test(t))
    return 'cybersecurity operations center, analyst at workstation with threat monitoring screens';
  if (/5g|telecom|wireless.network|spectrum|fiber.optic/.test(t))
    return 'cell tower antenna array against blue sky, wireless telecommunications infrastructure';
  if (/gaming|gpu.gaming|esports|console/.test(t))
    return 'gaming PC setup with RGB lighting, high-performance computer hardware, esports environment';
  if (/merger|acquisition|deal|buyout|strategic.review/.test(t))
    return 'two executives shaking hands in modern boardroom, corporate deal signing, business meeting';

  // ── Ticker fallbacks — only if no topic keyword matched ─────────────────
  const FALLBACK: Record<string, string> = {
    'NVDA':  'NVIDIA GPU server rack in data center, high-performance computing infrastructure',
    'AMD':   'processor chip on circuit board, semiconductor computing hardware, macro photography',
    'INTC':  'silicon wafer in semiconductor cleanroom, chip manufacturing, fabrication facility',
    'MU':    'DRAM memory modules on circuit board, data storage components, electronics closeup',
    'SNDK':  'flash storage SSD and memory cards, data storage technology, hardware photography',
    'MSFT':  'software developer coding on multiple monitors, tech office environment, modern workspace',
    'GOOGL': 'internet server infrastructure, search technology, digital information network',
    'META':  'smartphone showing social media feed, digital social network, content engagement',
    'AMZN':  'package delivery driver at front door, last-mile delivery, e-commerce logistics',
    'TSLA':  'Tesla electric car on highway, electric vehicle technology, sustainable transportation',
    'AAPL':  'iPhone on clean desk with laptop, consumer electronics, premium tech product',
    'NFLX':  'streaming entertainment on television, digital content platform, home viewing',
  };
  return FALLBACK[ticker] ||
    'financial analyst at trading desk with market data on screens, professional finance environment';
}

function buildPrompt(type: string, report: any, sector: string, ticker: string): string {
  const title   = report?.title   || '';
  const summary = report?.summary || '';
  const combined = `${title} ${summary}`;
  const up = (ticker || '').toUpperCase();

  const subject = extractSubject(combined, up);
  return `${subject}${PHOTO_BASE}`;
}

// ── Supabase REST helpers ─────────────────────────────────────────────────────
async function supaGet(table: string, filter: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}`, Accept: 'application/json' },
  });
  if (!r.ok) return [];
  return r.json();
}

async function supaPatch(table: string, filter: string, body: object): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
}

function ok(data: object) {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
function err(msg: string, status = 500) {
  return new Response(JSON.stringify({ ok: false, error: msg }), { status, headers: { 'Content-Type': 'application/json' } });
}

// ── Main ──────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  try {
    if (!SUPA_SVC) return err('SUPABASE_SERVICE_ROLE_KEY not set');
    if (!LEO_KEY)  return err('LEONARDO_API_KEY not set');

    const url    = new URL(req.url);
    const type   = url.searchParams.get('type')        ?? '';
    const date   = url.searchParams.get('report_date') ?? '';
    const sector = url.searchParams.get('sector')      ?? '';
    const ticker = url.searchParams.get('ticker')      ?? '';
    const force  = url.searchParams.get('force') === '1';

    if (!type || !date) return err('type and report_date required', 400);
    if (!['macro', 'sector', 'stock'].includes(type)) return err('invalid type', 400);

    // ── 1. Fetch report ─────────────────────────────────────────────────────
    const table = type === 'macro'  ? 'research_macro_reports'
                : type === 'sector' ? 'research_sector_reports'
                :                     'research_stock_reports';

    const filter = type === 'macro'
      ? `report_date=eq.${date}&select=title,summary,images&limit=1`
      : type === 'sector'
      ? `report_date=eq.${date}&sector=eq.${sector}&select=title,summary,images&limit=1`
      : `report_date=eq.${date}&ticker=eq.${encodeURIComponent(ticker)}&select=title,summary,images&limit=1`;

    const rows = await supaGet(table, filter);
    if (!rows.length) return err('Report not found', 404);
    const report = rows[0];

    // Skip if real images already exist (unless ?force=1)
    if (!force && Array.isArray(report.images) && report.images.some((img: any) => img?.url)) {
      return ok({ skipped: true, reason: 'Images already generated' });
    }

    // ── 2. Build prompt + kick off Leonardo directly ────────────────────────
    const prompt = buildPrompt(type, report, sector, ticker);

    const genResp = await fetch('https://cloud.leonardo.ai/api/rest/v1/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LEO_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        negative_prompt: 'text, watermark, logo, signature, blurry, distorted, low quality, cartoon, anime, illustration, painting',
        num_images: 4,
        width: 1024,
        height: 576,
      }),
    });
    const genRaw = await genResp.text();
    if (!genResp.ok) return err(`Leonardo start failed (${genResp.status}): ${genRaw.slice(0, 500)}`);
    let genData: any;
    try { genData = JSON.parse(genRaw); } catch (_e) { return err(`Leonardo non-JSON response: ${genRaw.slice(0, 300)}`); }
    const genId = genData.sdGenerationJob?.generationId;
    if (!genId) return err(`No generationId in Leonardo response: ${genRaw.slice(0, 300)}`);

    // ── 3. Poll Leonardo until COMPLETE (max 25 × 5s = 125s) ───────────────
    let imageUrls: string[] = [];
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollResp = await fetch(
        `https://cloud.leonardo.ai/api/rest/v1/generations/${encodeURIComponent(genId)}`,
        { headers: { Authorization: `Bearer ${LEO_KEY}` } },
      );
      if (!pollResp.ok) continue;
      const pd  = await pollResp.json();
      const gen = pd.generations_by_pk;
      if (gen?.status === 'COMPLETE' && gen?.generated_images?.length) {
        imageUrls = gen.generated_images.map((g: any) => g.url);
        break;
      }
      if (gen?.status === 'FAILED') break;
    }
    if (!imageUrls.length) return err('Leonardo generation timed out or failed');

    // ── 4. Download + upload to Supabase Storage via JS client ─────────────
    const supabase = createClient(SUPABASE_URL, SUPA_SVC, {
      auth: { persistSession: false },
    });

    const images: { url: string; alt: string }[] = [];
    const storageErrors: string[] = [];
    for (let i = 0; i < Math.min(imageUrls.length, 4); i++) {
      try {
        const imgResp = await fetch(imageUrls[i]);
        if (!imgResp.ok) { storageErrors.push(`CDN fetch ${i} failed: ${imgResp.status}`); continue; }
        const bytes = await imgResp.arrayBuffer();

        const pfx  = type === 'macro'  ? `macro/${date}`
                   : type === 'sector' ? `sector/${date}_${sector}`
                   :                     `stock/${date}_${ticker.toUpperCase()}`;
        const path = `${pfx}_${i}.jpg`;

        const { error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(path, bytes, { contentType: 'image/jpeg', upsert: true });

        if (upErr) {
          storageErrors.push(`Storage upload ${i} (${path}) failed: ${upErr.message}`);
          continue;
        }

        images.push({
          url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`,
          alt: prompt.slice(0, 120),
        });
      } catch (_e: any) { storageErrors.push(`Exception on image ${i}: ${_e?.message ?? _e}`); }
    }
    if (!images.length) return err(`Failed to store any images. Errors: ${storageErrors.join(' | ')}`);

    // ── 5. PATCH report row ─────────────────────────────────────────────────
    const patchFilter = type === 'macro'
      ? `report_date=eq.${date}`
      : type === 'sector'
      ? `report_date=eq.${date}&sector=eq.${sector}`
      : `report_date=eq.${date}&ticker=eq.${encodeURIComponent(ticker)}`;

    await supaPatch(table, patchFilter, { images });

    return ok({ ok: true, type, date, count: images.length });
  } catch (e: any) {
    return err(`Unhandled exception: ${e?.message ?? String(e)}`);
  }
});
