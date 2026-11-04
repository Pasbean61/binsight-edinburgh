/* BinSight Twin: answers questions about the site from its own data.
   Two engines: (1) Claude, when the page runs inside a Claude viewer that grants `sample`;
   (2) a built-in engine (intent rules over the live data + ranked knowledge base), always available. */
(() => {
"use strict";
const $ = s => document.querySelector(s);
const fmt = (n, d = 0) => n == null || isNaN(n) ? "–" : Number(n).toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const BS = window.BS, D = BS.D;

/* ── knowledge base ──────────────────────────────────
   q: phrasings people use · k: keywords · a: answer (markdown) · f: follow-ups · go: section */
const KB = [
  { id: "what", q: ["what is binsight", "what does this site do", "explain the project", "what is this", "summary", "overview", "elevator pitch", "tell me about binsight"], k: "binsight project idea pitch overview about",
    a: "**BinSight** helps cities collect waste at the right time, not on a fixed timetable. Sensors clip onto existing bins, a model forecasts how full each bin will be tomorrow, and a routing solver plans the shortest routes that reach only the bins that need emptying.\n\nThis site runs that engine on Edinburgh’s real communal bin network: {stops} general-waste stops from the council register in all 17 wards. Fill levels are simulated, because the council does not publish its sensor readings.", f: ["Is this data real?", "How does BinSight make money?", "Which ward needs the most collections tomorrow?"], go: "home" },
  { id: "problem", q: ["what problem does it solve", "why is this needed", "what is wrong with bin collection", "why do bins overflow", "root cause"], k: "problem overflow timetable fixed schedule demand root cause communal tenements",
    a: "Edinburgh empties communal bins on fixed timetables, but waste doesn’t arrive on a timetable. Dozens of households share each bin, and demand swings with short-term lets, students moving out, the August festivals, Hogmanay and businesses dumping trade waste.\n\nSo the council faces a bad choice: collect too often and waste money on half-empty bins, or too rarely and live with overflow, gulls and complaints. The real problem isn’t a lack of bins or trucks. It’s a lack of good decisions about **when and where** to collect, which is a prediction and routing problem.", f: ["How many complaints are there?", "Why communal bins specifically?", "How does it work?"], go: "problem" },
  { id: "communal", q: ["why communal bins", "what is a communal bin", "who uses communal bins", "how many communal bins"], k: "communal tenement flats shared on-street 60000 properties 18000",
    a: "About **60,000** flatted and multi-occupancy properties in Edinburgh share large on-street communal bins instead of having their own wheelie bins (City of Edinburgh Council, Communal Bin Review). The council’s asset register lists **{assets}** communal bins and recycling banks across all streams, close to the ~18,000 often quoted.\n\nKerbside bins suit fixed days because each home puts its own bin out. A communal bin pools many households, so its fill rate changes daily. That makes communal bins the hardest part of the service to run well.", f: ["Show me the council register on the map", "How many general-waste stops are there?"], go: "problem" },
  { id: "complaints", q: ["how many complaints", "overflowing bin reports", "6006", "short term lets bins", "airbnb bins"], k: "complaints reports overflowing 6006 short-term lets airbnb summer 2019 13%",
    a: "The council received **6,006** reports of full or overflowing bins in a single summer quarter (Q2 2019/20), **13 %** more than the year before, and linked part of the rise to short-term lets (Edinburgh Evening News, 2019). Council officials have said communal bins generate around ten times as many complaints as individual bins (Broughton Spurtle). In 2025 one councillor reported 84 overflowing communal bins in a single ward (Edinburgh Liberal Democrats).", f: ["Why do bins overflow?", "What does it cost the council?"], go: "problem" },
  { id: "recycling", q: ["recycling rate", "how much does edinburgh recycle", "contamination", "wrong bin", "landfill"], k: "recycling rate 37.5 28th 44.3 42.8 contamination 52% 17% landfill",
    a: "Edinburgh recycled **37.5 %** of household waste in 2024, ranking **28th of 32** Scottish councils (recycle.co.uk, 2026), against a Scottish rate of 44.3 % (SEPA). Scotland fell to 42.8 % in 2025 (letsrecycle.com).\n\nOverflow and recycling are linked: about **52 %** of what goes into general bins could have been recycled (SEPA, 2025), so general bins fill faster than they should, and about **17 %** of recycling arriving at Scottish sorting facilities is contaminated (SEPA, 2017).", f: ["What policies put pressure on councils?", "How does BinSight help recycling facilities?"], go: "problem" },
  { id: "cost", q: ["what does it cost", "council budget", "how much money", "collection cost", "savings needed"], k: "cost budget 20.2 94.2 5.07 266612 1.35 money savings",
    a: "Collection is getting more expensive. Edinburgh’s net collection cost rose **£5.07 per premise** in 2024/25 across 266,612 premises, roughly **£1.35m** more a year, and its street cleaning is the most expensive in Scotland per 1,000 people (CEC, LGBF 2024/25). Meanwhile the council must find **£20.2m** of recurring savings in 2026/27, rising to **£94.2m** by 2029/30 (CEC budget key facts).", f: ["How does gain-share work?", "What evidence is there that it saves money?"], go: "problem" },
  { id: "policy", q: ["policy pressure", "landfill ban", "pepr", "extended producer responsibility", "circular economy act", "why now"], k: "policy landfill ban 2028 pepr 17.3 circular economy act 2024 targets why now timing",
    a: "Three rules make efficiency urgent:\n- **Packaging EPR (from 2025):** producers pay councils for packaging waste. Edinburgh gets about **£17.3m** in 2026/27, and up to 20 % can be withheld from services judged inefficient (GOV.UK; COSLA).\n- **Landfill ban:** biodegradable municipal waste is banned from landfill, with SEPA enforcing fully from **1 January 2028**.\n- **Circular Economy (Scotland) Act 2024:** a statutory recycling code, council targets expected from 2030, and penalties for persistent contamination.", f: ["What does the council already have?", "How does BinSight make money?"], go: "problem" },
  { id: "how", q: ["how does it work", "how does binsight work", "the process", "steps", "sense predict optimise collect"], k: "how works steps sense predict optimise collect pipeline",
    a: "Four steps:\n1. **Sense:** a battery sensor in the bin lid measures fill level.\n2. **Predict:** a gradient-boosted model forecasts each bin 24 hours ahead, with an overflow probability.\n3. **Optimise:** a vehicle-routing solver plans the shortest routes covering only bins forecast to need emptying.\n4. **Collect:** crews follow the plan in a driver view; residents report problems in an app and earn vouchers.\n\nWe don’t make bins or run trucks. Councils keep their bins, vehicles and crews.", f: ["How accurate is the forecast?", "How are routes planned?", "Show me a truck route"], go: "how" },
  { id: "sensor", q: ["what sensor", "how does the sensor work", "hardware", "esp32", "ultrasonic", "battery"], k: "sensor hardware esp32 ultrasonic wokwi battery lid mount",
    a: "The prototype is an **ESP32 with an ultrasonic distance sensor** (simulated in Wokwi). It measures the gap between the lid and the waste, converts it to a fill percentage, and posts it to the platform’s `/api/bin/update` endpoint. The product is a small battery-powered unit with a universal mount that fits inside existing lids. It collects bin-level data only, no personal data.\n\nEdinburgh already has **11,000** sensors in communal and litter bins (£6.4m programme), so BinSight’s software can also run on sensors the council owns.", f: ["Does Edinburgh already use sensors?", "What does the platform do with the data?"], go: "how" },
  { id: "existing", q: ["does edinburgh already have sensors", "existing sensors", "glass bin sensors", "what does the council already have", "why not use existing sensors"], k: "existing sensors 11000 6.4m glass 2700 3400 dynamic manchester",
    a: "Yes. Edinburgh installed **11,000** smart sensors in communal and litter bins through projects budgeted at **£6.4m** (CEC), and by late 2024 **2,700 of about 3,400** communal glass bins had sensors, ahead of a move to fully dynamic collection (Edinburgh Reporter).\n\nMeasurement alone hasn’t fixed the problem: recycling is at a record low ranking and costs are rising. The missing step is turning data into decisions: forecasting, choosing which bins to skip, and routing. Manchester’s 2017 sensor trial worked technically but wasn’t financially viable without that step. That gap is where BinSight fits.", f: ["How are routes planned?", "What evidence is there that it saves money?"], go: "business" },
  { id: "model", q: ["how does the forecast work", "what model", "machine learning", "xgboost", "features", "how do you predict"], k: "model forecast machine learning xgboost gradient boosting features lag rolling",
    a: "The engine trains **{modelName}** to predict each stop’s fill level 24 hours ahead. It uses {nFeatures} features: fill 1, 2 and 24 hours ago, 6- and 24-hour rolling mean and spread, hours since the last collection, hour, weekday, month, weekend, Scottish bank holidays, temperature and rain, capacity and area type.\n\nTraining uses the first 75 % of the history; the last 25 % is the test set. It’s compared against “tomorrow = today” (persistence) and ridge regression.", f: ["How accurate is the forecast?", "What is the overflow probability?"], go: "results" },
  { id: "overflowprob", q: ["overflow probability", "how is risk calculated", "what does risk mean", "probability of overflow"], k: "overflow probability risk normal cdf rmse uncertainty",
    a: "The forecast has an error, so BinSight turns it into a probability. Assuming errors are roughly normal with spread equal to the test RMSE ({rmse} points):\n\n`P(overflow) = 1 − Φ((80 − forecast) / RMSE)`\n\nA stop forecast at 78 % gets a meaningful chance of passing 80 %; one at 50 % gets almost none. The Brier score of these probabilities on the test set is {brier}.", f: ["What is the priority score?", "Which stops are highest risk?"], go: "how" },
  { id: "priority", q: ["priority score", "how are bins chosen", "which bins get collected", "selection rule", "threshold"], k: "priority score selection rule threshold 80 75 weights",
    a: "A stop is scheduled if its forecast is **≥ 80 %**, or its **priority score ≥ 75**:\n\n`priority = 0.6 × forecast + 0.2 × 100 × P(overflow) + 0.2 × 100 × area weight`\n\nArea weights are 0.9 for the City Centre, 0.6 inner residential and 0.4 outer residential. Tomorrow that flags **{flagged}** of {stops} stops. In the experiments the weights barely change the outcome; the collection threshold matters far more. Collecting at a 75 % forecast instead of 80 % cuts overflow bin-hours by about {abl75} for about {abl75km} more driving. On simulated data the overflow probability is almost always 0 or 1, so the risk term adds little.", f: ["What if we collect at 70 %?", "Does the priority score help?"], go: "results" },
  { id: "routing", q: ["how are routes planned", "routing", "vehicle routing", "or-tools", "cvrp", "optimisation", "solver"], k: "routing vrp cvrp or-tools solver optimise guided local search depot trips capacity",
    a: "Routing is a **capacitated vehicle-routing problem** solved with Google OR-Tools: start from the cheapest-arc solution, then improve with guided local search. Each truck carries {truckCap} L of bin volume per load and can return to Seafield depot to tip and go out again up to {tripsPer} times. Distances are great-circle × 1.3.\n\nTomorrow’s plan: **{served}** stops, **{trips}** trips by **{trucksUsed}** trucks, **{km} km**. Snapped to real streets with OSRM, it’s {roadKm} km by road.", f: ["Show me a truck route", "Can the crews actually finish this?", "Where is the depot?"], go: "how" },
  { id: "depot", q: ["where is the depot", "seafield", "where do trucks start"], k: "depot seafield start trucks base",
    a: "Trucks start and tip at **Seafield depot**, next to the Seafield household waste recycling centre on Seafield Road in Leith (55.9675 N, 3.1372 W). Its position comes from the council’s own bin records at that site.", f: ["Show me a truck route", "How many trucks are used?"], go: "console" },
  { id: "real", q: ["is this data real", "is the data fake", "what is simulated", "where does the data come from", "how real is it", "data sources", "provenance"], k: "real fake simulated data source provenance open data council ons osm weather",
    a: "**Real:** every stop’s location, bin count, bin size and street description (City of Edinburgh Council asset register, {assets} records, Open Government Licence); the ward of every stop (ONS ward boundaries); streets, rivers and parks (OpenStreetMap); route geometry on real streets (OSRM); hourly Edinburgh weather (Open-Meteo); Scottish bank holidays; and every statistic in the problem and business sections, each with a source.\n\n**Simulated:** fill levels, collections, sensor battery and signal, and so the forecasts and routes built on them. The council doesn’t publish its sensor readings, so the engine simulates fill with EcoBin’s hourly model, driven by real Edinburgh weather.\n\n**Assumed:** fleet size (24 trucks), truck capacity, 3 trips a shift, 10 minutes per stop, 30 km/h.", f: ["How is fill simulated?", "What are the limitations?"], go: "sources" },
  { id: "sim", q: ["how is fill simulated", "simulation model", "how do bins fill", "fill rate"], k: "simulation fill rate model ecobin peak hours holidays rain temperature",
    a: "Each hour, a stop’s fill grows by: area base rate × peak-hour factor (1.8 at peak, 0.6 off-peak) × day factor (weekends +10 %, bank holidays +10–30 %) × temperature and rain effects × a random factor. Each stop has its own lognormal rate multiplier, so neighbouring bins behave differently. Bins are emptied in the history when they pass 85 % or after 72–120 hours.\n\nBase rates: City Centre 1.5 %/h, inner residential 1.2 %/h, outer residential 0.95 %/h. The weather is the real hourly Edinburgh record for {weatherRange}.", f: ["What was the weather?", "Is this data real?"], go: "sources" },
  { id: "limits", q: ["limitations", "weaknesses", "what is missing", "caveats", "assumptions", "critique"], k: "limitations weakness assumptions caveats shift constraint simulated optimistic",
    a: "The main limits:\n- **Fill levels are simulated**, so model accuracy (R² {r2}) is optimistic; real sensor data is noisier.\n- **No shift-length limit** in the solver: tomorrow’s plan needs about {perTruck} hours per truck at 10 min a stop.\n- **Fleet figures are assumptions**, not council data.\n- **Distances** use great-circle × 1.3 inside the solver. Snapped to real streets, tomorrow’s routes are {roadKm} km, **{roadGap} longer** than the solver’s {km} km, so a road-distance matrix would improve the plan.\n- **One waste stream:** only general-waste communal bins are routed; glass, packaging and food use different vehicles.\n- Experiments use {days} replayed days × {seeds} seeds, enough to compare strategies, not to promise savings.", f: ["Can the crews actually finish this?", "Is this data real?"], go: "results" },
  { id: "reality", q: ["can the crews finish", "shift length", "is the plan feasible", "how many hours", "working time", "reality check"], k: "shift hours feasible crew time working service minutes per stop",
    a: "Not as modelled. The plan sends {trucksUsed} trucks to {served} stops. At 10 minutes a stop that’s **{liftH} h** of lifting plus **{driveH} h** of driving, about **{perTruck} h per truck** against an 8-hour shift. The solver (like EcoBin’s) has no time limit.\n\nFixes: add a working-time constraint, use a realistic lift time (a mechanised communal lift is likely 2–5 minutes), or add crews. Try it in the planner.", f: ["What if each stop takes 4 minutes?", "What if we had 40 trucks?"], go: "planner" },
  { id: "results", q: ["results", "does it work", "what did the experiment show", "compare strategies", "fixed vs predictive", "is it better than a timetable"], k: "results experiment strategies fixed reactive predictive compare overflow distance",
    a: "In the {days}-day × {seeds}-seed replay (simulated fill, same 24 trucks):\n\n| Strategy | km/day | Overflow bin-h/day | Emptied under 40 % |\n|---|--:|--:|--:|\n{stratRows}\n\nForecast-driven collection cuts overflow bin-hours by **{overflowCut}** compared with the fixed rota, for **{distChange}** distance. Reacting to current fill alone saves driving but lets bins overflow first.", f: ["Why not just empty bins when they're full?", "Does the priority score help?", "What are the limitations?"], go: "results" },
  { id: "reactive", q: ["why not just empty bins when they are full", "reactive", "why predict", "why forecast instead of reacting"], k: "reactive full now why forecast predict instead",
    a: "Because by the time a bin reads full, it’s too late: the truck can’t get there before it overflows. In the replay the reactive rule (empty when fill now ≥ 80 %) waits until bins average **{reactiveFill} %**, and causes **{reactiveEvents}** overflow events a day against **{predEvents}** for the forecast rule. Forecasting tomorrow lets crews arrive just before a bin fills.", f: ["How accurate is the forecast?", "Show me the results"], go: "results" },
  { id: "planner", q: ["how do i use the planner", "what if", "scenario", "change the threshold", "planner"], k: "planner what-if scenario threshold fleet shift sliders bhh beardwood",
    a: "The planner recomputes tomorrow’s plan from all {stops} forecasts as you move the sliders: collection threshold, trucks, shift length, minutes per stop and speed. It shows stops, waste, truck loads, distance, CO₂, crew-hours and whether the fleet can finish.\n\nDistance uses the **Beardwood–Halton–Hammersley** law: route length grows like k·√(n·A) for n stops spread over area A, plus the trips to and from the depot. k is fitted so the formula reproduces the optimised plan. You can also ask me, e.g. “What if we collect at 70 % with 30 trucks?”", f: ["What if we collect at 70 % with 30 trucks?", "What if each stop takes 4 minutes?"], go: "planner" },
  { id: "products", q: ["what do you sell", "products", "what is the platform", "resident app"], k: "products sell sensor platform resident app api",
    a: "Three products:\n- **BinSight Sensor:** a small battery fill-level sensor that clips onto existing communal, trade and campus bins.\n- **BinSight Platform:** a live fill map, fill-time forecasts, optimised daily routes, reports, and an API into councils’ existing route-planning tools.\n- **BinSight Resident App:** free; residents report full or misused bins and earn vouchers, funded through Models A and G.\n\nWe don’t sell bins or provide collections.", f: ["Who are the customers?", "How does BinSight make money?"], go: "how" },
  { id: "customers", q: ["who are the customers", "who buys it", "target market", "market"], k: "customers buyers market councils contractors universities businesses events 18000",
    a: "- **Local councils** (primary): sensors plus subscription, or gain-share.\n- **Private waste contractors:** sensors and a platform licence for their own fleets.\n- **Universities and student accommodation:** move-in and move-out peaks.\n- **Businesses and landlords:** trade bins collected only when nearly full.\n- **Event organisers:** short-term rental for peaks like the August festivals, when Edinburgh’s population roughly doubles.\n\nEdinburgh alone has around 18,000 communal bins, each a potential sensor.", f: ["How does BinSight make money?", "What is the go-to-market plan?"], go: "business" },
  { id: "money", q: ["how does binsight make money", "revenue model", "business model", "pricing", "how do you earn"], k: "money revenue business model pricing earn subscription fee",
    a: "Seven revenue models; the core ones are:\n- **A, councils:** a one-off fee per sensor plus an annual platform subscription per sensor (or hardware-as-a-service).\n- **B, gain-share:** no upfront cost; the council pays a share (e.g. 25 %) of verified savings.\n- **G, community rewards:** local businesses pay a platform fee to sponsor resident vouchers; the council co-funds rewards from its savings.\n\nAlso C (contractor licence), D (small-business sensor subscription), E (data reports), F (move-out bundle with the student marketplace). Prices will be set after the pilot.", f: ["How does gain-share work?", "Explain model G", "Who pays what?"], go: "business" },
  { id: "modelA", q: ["model a", "sensor subscription", "hardware as a service"], k: "model a subscription one-off fee sensor hardware service civtech procurement",
    a: "**Model A, the core model:** two revenue streams from councils: (1) a one-off fee per sensor covering hardware and installation on existing bins, and (2) an annual subscription per connected sensor covering software, data, maintenance and battery replacement. The alternative, hardware as a service, spreads the sensor cost into a higher subscription for councils with tight capital budgets. Entry is via a funded pilot (CivTech, Zero Waste Scotland, Innovate UK), then multi-year procurement.", f: ["How does gain-share work?", "What is the go-to-market plan?"], go: "business", model: "A" },
  { id: "modelB", q: ["model b", "gain share", "gain-share", "pay from savings", "share of savings"], k: "model b gain share savings 25% 72.35 14.47 3.62 362000 1.09m",
    a: "**Model B, pay from savings:** we fit sensors and run the platform at no upfront cost; the council pays a fixed share of verified savings.\n\nWorked example from our plan: Scotland’s average household collection cost is **£72.35** per property per year (LGBF 2020/21). A conservative 20 % saving is £14.47; at a 25 % share we earn **£3.62 per property**. For 100,000 properties that’s about **£362,000 a year** for BinSight while the council keeps about **£1.09m**.\n\nAsk me with your own numbers, e.g. “gain-share for 50,000 properties at 30 % saving”.", f: ["Gain-share for 50,000 properties at 30 % saving", "What evidence is there that it saves money?"], go: "business", model: "B" },
  { id: "modelC", q: ["model c", "contractors licence", "private contractors"], k: "model c contractor licence private waste companies",
    a: "**Model C:** private waste companies buy sensors for the bins they service and pay a monthly licence to run our forecasting and routing engine on their own fleets.", f: ["How does BinSight make money?"], go: "business", model: "C" },
  { id: "modelD", q: ["model d", "small business", "trade waste", "shops restaurants"], k: "model d small business trade waste shop restaurant monthly",
    a: "**Model D:** a shop or restaurant pays a small monthly fee for a sensor on its own trade-waste bin. The platform alerts their existing contractor only when the bin is nearly full, so they pay for fewer, fuller collections.", f: ["How does BinSight make money?"], go: "business", model: "D" },
  { id: "modelE", q: ["model e", "data reports", "sell data", "insight reports"], k: "model e data insight reports anonymised policymakers packaging producers",
    a: "**Model E:** anonymised sensor data on waste volumes, recycling and contamination, sold as reports to councils for service planning and to policymakers and packaging producers.", f: ["How does BinSight help recycling facilities?"], go: "business", model: "E" },
  { id: "modelF", q: ["model f", "student marketplace", "move out", "universities move-out", "idea 1"], k: "model f student marketplace move-out universities reuse idea 1",
    a: "**Model F, joint offer with Idea 1 (the student marketplace):** during move-out, sensors show universities where and when waste peaks, while reusable items go to the student marketplace instead of the bin. Universities get one move-out solution for reuse and waste monitoring.", f: ["What is the go-to-market plan?"], go: "business", model: "F" },
  { id: "modelG", q: ["model g", "rewards", "vouchers", "community reporting", "resident rewards", "points"], k: "model g community reporting rewards vouchers points residents misuse verified",
    a: "**Model G, community reporting rewards:** residents report full, overflowing or misused bins in the app with a photo and location. Once verified (by sensor data or the crew) they earn points for vouchers from local restaurants, cafés and home-goods shops. The council funds part of the reward pool from savings on complaints and missed collections; local businesses sponsor vouchers for footfall and visibility and pay us a platform fee.\n\nResidents become “human sensors” for bins without one. Misuse controls: only verified reports earn points, a daily limit per user, and only the first report on a bin is rewarded.", f: ["Who pays what?", "What are the risks?"], go: "business", model: "G" },
  { id: "partners", q: ["who pays what", "three partners", "council community recycling facilities", "millerhill"], k: "partners council community recycling facilities millerhill pays gets",
    a: "Three partners, each paying for what they get:\n- **City of Edinburgh Council (Model A):** fewer overflows and complaints, lower costs, progress on recycling and the 2028 ban. Pays per sensor plus an annual subscription, and co-funds the reward pool.\n- **Community (Model G):** residents get cleaner streets and vouchers; local businesses get footfall and pay to sponsor vouchers.\n- **Recycling facilities** such as Millerhill Recycling and Energy Recovery Centre: forecasts of what will arrive and when, and early contamination warnings. They pay an annual data subscription or a share of the extra value.", f: ["How does gain-share work?", "What are the risks?"], go: "business" },
  { id: "gtm", q: ["go to market", "roadmap", "pilot", "next steps for the startup", "how will you launch", "phases"], k: "go-to-market roadmap pilot phase campus council scale civtech",
    a: "1. **Campus pilot (0–6 months):** sensors on 50–100 existing bins at a university or student residence, to prove savings and build data.\n2. **Council pilot (6–18 months):** communal bins in one Edinburgh area, funded through CivTech, Zero Waste Scotland or Innovate UK, and launch the resident app there.\n3. **Scale (18 months +):** other Scottish councils (32 in total) and private contractors, then the rest of the UK.\n\nPartners: an outsourced hardware manufacturer, IoT network providers, existing route-planning vendors (we integrate), bin owners and reward sponsors.", f: ["What are the risks?", "Who are the customers?"], go: "business" },
  { id: "risks", q: ["risks", "what could go wrong", "challenges", "threats"], k: "risks procurement vandalism gdpr misuse sensors damaged",
    a: "Main risks and responses:\n- Slow public procurement → early revenue from universities, businesses and contractors; grant-funded pilots.\n- Many bin shapes → a universal mounting kit.\n- Vandalism → robust, low-cost sensors inside the lid.\n- Councils already have route software → integrate through an API.\n- UK GDPR → bin-level data only; minimal, consented app data.\n- Savings unproven → gain-share, so the council pays only for results.\n- Fake reports → only verified reports earn points, daily limits.\n- From our own model: the plan exceeds an 8-hour shift, so the solver needs a working-time constraint.", f: ["Can the crews actually finish this?", "What evidence is there that it saves money?"], go: "business" },
  { id: "evidence", q: ["what evidence is there", "does smart collection save money", "studies", "proof", "hannan", "derby"], k: "evidence studies hannan 44% derby 53% sensoneo proof",
    a: "- **Hannan et al. (2020)**, Sustainable Cities and Society: routing on real-time fill levels cut collection cost by **44 %** and emissions by **18 %**, and raised efficiency **26 %**, at a 70 % fill threshold (modelling study).\n- **Derby City Council:** a 200-bin sensor trial cut bin visits by **53 %** and reduced overflow complaints.\n- Vendor deployments report 43–63 % savings (Sensoneo; treat with caution).\n- **Ramos et al. (2018):** sensor data improves collection only when combined with route optimisation.\n\nResults depend on local conditions, which is why the plan starts with a pilot.", f: ["What did this site's experiment show?", "Does Edinburgh already have sensors?"], go: "business" },
  { id: "wards", q: ["what are the wards", "how many wards", "ward list", "areas of edinburgh"], k: "wards 17 electoral areas boundaries ons",
    a: "Edinburgh has **17 multi-member electoral wards**. Every stop is assigned to its ward using official ONS boundaries (Wards, December 2024). The most stops are in {topWards}. Ask me about any ward, for example “How is Leith doing?”", f: ["Which ward needs the most collections tomorrow?", "Which ward has the most bins?"], go: "console" },
  { id: "areas", q: ["area types", "city centre inner outer", "why area type"], k: "area type city centre inner outer residential rings distance princes street",
    a: "Area type is a modelling choice, not council data. The open data has no land-use field, so stops are grouped by distance from Princes Street: **City Centre** (< 1.2 km), **Inner Residential** (< 3.5 km), **Outer Residential**. It sets fill rates and the location part of the priority score. Wards on the map are real; area types are not.", f: ["How is fill simulated?", "What are the wards?"], go: "sources" },
  { id: "co2", q: ["emissions", "co2", "carbon", "fuel", "environment"], k: "co2 emissions carbon fuel diesel environment",
    a: "The engine counts diesel at 0.30 L per km and 2.68 kg CO₂ per litre. Tomorrow’s plan of {km} km burns about {fuel} L and emits about **{co2} kg CO₂**. In the replay the predictive rule drives slightly further than the fixed rota, because it reaches the bins that need it rather than a fixed third of the city; the gain is in overflow, not distance. Hannan et al. (2020) report an 18 % emissions cut in their study.", f: ["What did this site's experiment show?"], go: "results" },
  { id: "team", q: ["who made this", "who built this", "team", "ems group 6", "authors", "credits"], k: "team authors credits group ems university edinburgh ecobin",
    a: "BinSight is a project by **EMS Group 6 at the University of Edinburgh**. The forecasting and routing engine is adapted from the team’s BinSight repository, which itself adapts **EcoBin** by Rishvin Reddy (MIT licence), re-built here for Edinburgh’s real bin network, real wards and real weather. The full engine (Python, FastAPI, OR-Tools, ESP32 sketch) is in the `engine/` folder of this site’s repository.", f: ["Is this data real?", "How does it work?"], go: "sources" },
  { id: "engine", q: ["can i run it", "source code", "github", "backend", "api", "fastapi"], k: "source code github run engine backend fastapi api local",
    a: "Yes. The repository’s `engine/` folder holds the full pipeline: `python run_pipeline.py` builds the stops, simulates history, trains the model, forecasts, routes and runs the experiments; `uvicorn backend.main:app` starts the FastAPI backend with 40+ endpoints (IoT ingestion, predictions, routing, driver and maintenance portals, QR identity, WebSocket). `scripts/build_site_data.py` exports this website’s data.", f: ["How are routes planned?", "Who made this?"], go: "sources" },
  { id: "site", q: ["how do i use this site", "help", "what can you do", "what can i ask", "navigation"], k: "help use site navigate ask twin can do",
    a: "I can answer from this site’s data. Try:\n- a **street**: “How full are the bins on Easter Road?”\n- a **ward**: “How is Morningside doing tomorrow?”\n- a **truck**: “Show me truck 7’s route”\n- **rankings**: “Which ward has the most flagged stops?”\n- **what-ifs**: “What if we collect at 70 % with 30 trucks?”\n- **money**: “Gain-share for 50,000 properties”\n- the **business plan**, **sources** and **limitations**.\n\nI’ll move the map for you when it helps.", f: ["Which ward needs the most collections tomorrow?", "How full are the bins on Easter Road?", "Is this data real?"], go: "home" },
  { id: "festival", q: ["festival", "fringe", "august", "hogmanay", "events", "tourists"], k: "festival fringe august hogmanay events tourists peaks",
    a: "Edinburgh’s population roughly doubles during the August festivals (Circular Online), and the Fringe alone brings about 500 extra tonnes of glass. Hogmanay and Christmas add further peaks. Those are exactly the swings a fixed timetable can’t follow. Event organisers are a customer group for short-term sensor rental. The simulated history on this site covers October to early November, so it doesn’t include a festival peak.", f: ["Who are the customers?", "What was the weather?"], go: "problem" },
  { id: "gdpr", q: ["privacy", "gdpr", "personal data", "data protection"], k: "privacy gdpr personal data protection consent",
    a: "Sensors collect **bin-level data only**: fill level, battery, signal. The resident app collects minimal personal data, with consent, under UK GDPR. Data sold in Model E is anonymised.", f: ["What are the risks?"], go: "business" },
];

/* ── text utilities ─────────────────────────────── */
const STOP = new Set("a an the is are was were be been of to in on for and or with what which who how why when where does do did can could would should will i me my you your it its this that these those there their at by from as about into tomorrow today please tell show give much many any some just also than then so we our us get".split(" "));
const stem = w => w.replace(/(ings|ing|ies|ied|es|s|ed|ly)$/, m => m === "ies" || m === "ied" ? "y" : "").replace(/(.)\1$/, "$1");
const toks = s => (s.toLowerCase().normalize("NFKD").replace(/[’']/g, "").match(/[a-z0-9.%£]+/g) || []).filter(w => !STOP.has(w)).map(stem).filter(w => w.length > 1 && !STOP.has(w));
let IDF = null, DOCS = null;
function buildIndex() {
  DOCS = KB.map(e => ({ e, head: new Set(toks(e.q.join(" ") + " " + e.k)), body: toks(e.a) }));
  const df = new Map(); DOCS.forEach(d => new Set([...d.head, ...d.body]).forEach(t => df.set(t, (df.get(t) || 0) + 1)));
  IDF = t => Math.log(1 + KB.length / (1 + (df.get(t) || 0)));
}
function retrieve(q, k = 3) {
  if (!DOCS) buildIndex();
  const qt = toks(q), ql = q.toLowerCase();
  return DOCS.map(d => {
    let s = 0;
    for (const t of qt) { if (d.head.has(t)) s += 2.2 * IDF(t); else if (d.body.includes(t)) s += .6 * IDF(t); }
    for (const p of d.e.q) if (WORD(p).test(ql)) s += 4 + p.length / 8;
    return { e: d.e, s };
  }).sort((a, b) => b.s - a.s).slice(0, k);
}

/* ── facts used in answers ───────────────────────── */
function facts() {
  const s = D.site, p = s.plan, t = s.totals, ex = s.experiments, f = s.fleet;
  const st = n => ex.aggregate.find(r => r.Strategy === n);
  const F = st("Fixed"), P = st("Predictive"), R = st("Reactive");
  const best = s.model.results[s.model.name] || {};
  const lift = p.served * f.service_min / 60, drive = p.solver_km / f.speed_kmh;
  const lbl = { Fixed: "Fixed rota", Reactive: "Reactive (fill now)", Predictive: "Predictive (forecast)", "Full EcoBin": "Forecast + priority" };
  const fo = ex.ablation.find(r => r.Variant === "Only_Forecasting"), fu = ex.ablation.find(r => r.Variant === "Full_EcoBin_Proposed");
  return {
    abl75: fo && fu ? fmt(100 * (1 - fo.Overflow_Bin_Hours_mean / fu.Overflow_Bin_Hours_mean)) + " %" : "–",
    roadGap: fmt(100 * (p.road_km / p.solver_km - 1)) + " %",
    abl75km: fo && fu ? fmt(100 * (fo.Distance_km_mean / fu.Distance_km_mean - 1)) + " %" : "–",
    stops: fmt(t.stops), assets: fmt(t.assets), flagged: fmt(p.flagged), served: fmt(p.served), trips: p.trips, trucksUsed: p.trucks_used,
    km: fmt(p.solver_km), roadKm: fmt(p.road_km), co2: fmt(p.co2_kg), fuel: fmt(p.solver_km * .3), truckCap: fmt(f.capacity_l), tripsPer: f.trips_per_truck,
    modelName: s.model.name, nFeatures: s.model.features.length, rmse: fmt(s.model.rmse, 2), brier: fmt(s.model.residual.brier_score, 4), r2: fmt(best.R2, 3),
    liftH: fmt(lift), driveH: fmt(drive), perTruck: fmt((lift + drive) / p.trucks_used, 1),
    days: ex.manifest.configuration.days, seeds: ex.manifest.configuration.seeds,
    overflowCut: fmt(100 * (1 - P.Overflow_Bin_Hours_mean / F.Overflow_Bin_Hours_mean)) + " %",
    distChange: (P.Distance_km_mean >= F.Distance_km_mean ? "+" : "−") + fmt(Math.abs(100 * (P.Distance_km_mean / F.Distance_km_mean - 1))) + " %",
    reactiveFill: fmt(R.Mean_Fill_at_Collection_mean), reactiveEvents: fmt(R.Overflow_Events_mean), predEvents: fmt(P.Overflow_Events_mean),
    stratRows: ["Fixed", "Reactive", "Predictive", "Full EcoBin"].map(n => { const r = st(n); return `| ${lbl[n]} | ${fmt(r.Distance_km_mean)} | ${fmt(r.Overflow_Bin_Hours_mean)} | ${fmt(r.Unnecessary_Collections_mean, 1)} |`; }).join("\n"),
    topWards: [...D.wards].sort((a, b) => b.stops - a.stops).slice(0, 3).map(w => `${w.name} (${w.stops})`).join(", "),
    weatherRange: new Date(s.weather.start).toLocaleDateString("en-GB", { day: "numeric", month: "long" }) + " to " + new Date(s.weather.history_end).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
  };
}
const fill = (a, F) => a.replace(/\{(\w+)\}/g, (_, k) => F[k] ?? "");

/* ── built-in engine: intents over live data ─────── */
const WORD = s => new RegExp("(^|[^a-z])" + s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z]|$)", "i");
function findWard(q) {
  const l = q.toLowerCase(); let best = -1, len = 0;
  D.wards.forEach((w, i) => {
    const names = [w.name.toLowerCase(), ...w.name.toLowerCase().split("/")];
    for (const n of names) if (n.length >= 4 && WORD(n).test(l) && n.length > len) { best = i; len = n.length; }
  });
  return best;
}
function findStreet(q) {
  const l = " " + q.toLowerCase().replace(/[’']/g, "") + " "; let best = null;
  for (const name of D.streetNames) {
    const n = name.toLowerCase().replace(/[’']/g, "");
    if (n.length >= 5 && WORD(n).test(l) && (!best || n.length > best.length)) best = name;
  }
  return best;
}
const pctTok = q => { const m = q.match(/(\d{2})\s*(%|percent|per cent)/); return m ? +m[1] : null; };
function numNear(q, words) { const re = new RegExp("(\\d+(?:[.,]\\d+)?)\\s*(k|,000)?\\s*(?:" + words + ")", "i"); const m = q.match(re); if (!m) return null; let v = parseFloat(m[1].replace(",", "")); if (m[2] === "k") v *= 1000; return v; }
function stopLine(i) { const S = D.S; return `${S.site[i]}${S.loc[i] ? " (" + S.loc[i] + ")" : ""}: ${fmt(S.fill[i])} % now → **${fmt(S.pred[i])} %** tomorrow${S.truck[i] >= 0 ? `, stop ${S.ord[i]} on ${D.trucks[S.truck[i]].truck}` : ""}`; }

function local(q) {
  const ql = q.toLowerCase().trim(), F = facts(), S = D.S;
  if (/^(hi|hello|hey|hiya|good (morning|afternoon|evening))\b/.test(ql) && ql.length < 30)
    return { text: `Hello! I’m the BinSight twin. I know every one of Edinburgh’s ${F.stops} general-waste communal bin stops on this site, tomorrow’s routes, the results and the business plan. What would you like to know?`, f: ["Which ward needs the most collections tomorrow?", "How full are the bins on Easter Road?", "Is this data real?"] };
  if (/\b(thank|thanks|cheers)\b/.test(ql)) return { text: "You’re welcome. Ask me anything else about the bins, the routes or the plan.", f: ["What are the limitations?", "How does BinSight make money?"] };

  // stop id
  const idm = ql.match(/edi-?(\d{4,})/);
  if (idm) { const i = D.idx.get("EDI-" + idm[1]); if (i != null) return { text: `**${S.id[i]}** is a communal bin stop at ${stopLine(i)}. It has ${S.nb[i]} bin(s), ${fmt(S.cap[i])} L in total, in ${D.wards[S.ward[i]].name}. Chance of passing 80 %: ${fmt(S.prob[i] * 100, 1)} %. (Fill levels are simulated.)`, acts: [["Show on map", () => BS.focusStop(i)]] }; }

  // what-if planner
  const wantsWhatIf = /\bwhat if\b|\bscenario\b|\bsuppose\b|\bif we\b|\bwith \d+ trucks\b|minutes? (per|a) stop|\bthreshold\b/.test(ql);
  if (wantsWhatIf && !/propert/.test(ql)) {
    const o = { thr: pctTok(ql) ?? 80, fleet: numNear(ql, "trucks?|vehicles?|lorries") ?? 24, svc: numNear(ql, "min(?:ute)?s?(?: per| a)? stop|min(?:ute)?s?") ?? 10, shift: numNear(ql, "h(?:ou)?r?s?(?: shift)?|hour shift") ?? 8 };
    o.thr = Math.max(50, Math.min(95, o.thr)); o.fleet = Math.max(1, Math.min(60, o.fleet)); o.svc = Math.max(1, Math.min(30, o.svc)); o.shift = Math.max(4, Math.min(14, o.shift));
    const r = BS.planCalc(o), base = BS.planCalc({});
    const an = /^(8|11|18)/.test(String(o.thr)) ? "an" : "a";
    return { text: `With ${an} **${o.thr} %** threshold, **${o.fleet}** trucks, **${o.shift} h** shifts and **${o.svc} min** per stop:\n- **${fmt(r.n)}** stops to empty${r.n !== base.n ? ` (vs ${fmt(base.n)} at the default)` : ""}, ${fmt(r.litres / 1000)} m³ of waste, ${r.trips} truck loads\n- about **${fmt(r.km)} km** and ${fmt(r.co2)} kg CO₂\n- **${fmt(r.need)}** crew-hours needed vs ${fmt(r.have)} available → ${r.ok ? "**feasible**" : `**not feasible**; you’d need about ${r.trucksNeeded} trucks`}\n- about ${fmt(r.missP, 1)} skipped stops expected to pass 80 %\n\nDistance is a calibrated estimate (Beardwood–Halton–Hammersley), not a full re-solve.`, acts: [["Open in the planner", () => { BS.planner(o); document.getElementById("planner").scrollIntoView(); }]], f: ["What if each stop takes 4 minutes?", "Can the crews actually finish this?"] };
  }

  // gain-share calculator
  if (/gain|share of (the )?saving|pay from saving|revenue for|earn from|propert/.test(ql) && /\d/.test(ql)) {
    const P = numNear(ql, "propert(?:y|ies)|homes|households") ?? 100000;
    const pcts = [...ql.matchAll(/(\d{1,2}(?:\.\d+)?)\s*%/g)].map(m => +m[1]);
    let save = 20, share = 25;
    const sm = ql.match(/(\d{1,2})\s*%\s*(?:saving|savings|cost saving)/) || ql.match(/saving[s]? (?:of )?(\d{1,2})\s*%/);
    const shm = ql.match(/(\d{1,2})\s*%\s*share/) || ql.match(/share (?:of )?(\d{1,2})\s*%/);
    if (sm) save = +sm[1]; else if (pcts.length) save = pcts[0];
    if (shm) share = +shm[1]; else if (pcts.length > 1) share = pcts[1];
    const g = BS.gainShare(P, 72.35, save, share);
    return { text: `Gain-share for **${fmt(P)} properties**, a **${save} %** saving and a **${share} %** share, at Scotland’s average £72.35 per property:\n- total saving: **£${fmt(g.saving)}** a year\n- BinSight earns **£${fmt(g.binsight)}** (£${fmt(g.perProperty, 2)} per property)\n- the council keeps **£${fmt(g.council)}**`, acts: [["Open the calculator", () => { const s = document.getElementById("cProps"); s.value = P; document.getElementById("cSave").value = save; document.getElementById("cShare").value = share; s.dispatchEvent(new Event("input")); s.scrollIntoView({ block: "center" }); }]], f: ["What evidence is there that it saves money?", "Explain model G"] };
  }

  // truck
  const tm = ql.match(/(?:truck|rcv|route|driver|lorry|vehicle)\s*(?:no\.?|number|#)?\s*-?0?(\d{1,2})\b/);
  if (tm) {
    const ti = D.trucks.findIndex(t => t.truck.endsWith("-" + tm[1].padStart(2, "0")));
    if (ti < 0) return { text: `Truck ${tm[1]} has no route tomorrow. ${D.trucks.length} of the 24 trucks are needed: ${D.trucks.map(t => t.truck.replace("EDI-RCV-", "")).join(", ")}.`, f: ["Show me truck " + D.trucks[0].truck.replace("EDI-RCV-", "")] };
    const t = D.trucks[ti], wards = Object.entries(t.wards).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w, c]) => `${w} (${c})`).join(", ");
    const first = t.trips[0].stops.slice(0, 4).map(i => S.site[i]).join(" → ");
    return { text: `**${t.truck}** (${t.driver}) runs **${t.trips.length} trips** from Seafield, emptying **${t.stops.length} stops** and ${fmt(t.load)} L of waste over **${fmt(t.km, 1)} km** (${fmt(t.road, 1)} km on real streets). Mostly ${wards}.\n\nIt starts: ${first} …`, acts: [["Show route on map", () => { BS.focusTruck(ti); document.getElementById("console").scrollIntoView(); }], ["Open driver view", () => { BS.openTab("routes"); document.getElementById("ctabs").scrollIntoView(); }]], f: ["Can the crews actually finish this?", "Which truck has the longest route?"] };
  }

  // superlatives / rankings
  const sup = ql.match(/\b(most|highest|biggest|largest|top|busiest|fullest|worst|least|lowest|fewest|smallest|emptiest|longest|shortest|best)\b/);
  if (sup) {
    const low = /least|lowest|fewest|smallest|emptiest|shortest|best/.test(sup[1]);
    if (/truck|route|driver/.test(ql)) {
      const key = /stop/.test(ql) ? ["stops", t => t.stops.length, "stops"] : ["km", t => t.km, "km"];
      const r = [...D.trucks].sort((a, b) => (key[1](b) - key[1](a)) * (low ? -1 : 1)).slice(0, 3);
      return { text: `${low ? "Shortest" : "Longest"} routes by ${key[2]}:\n${r.map(t => `- **${t.truck}**: ${fmt(t.km, 1)} km, ${t.stops.length} stops, ${t.trips.length} trips`).join("\n")}`, acts: [["Show " + r[0].truck, () => BS.focusTruck(r[0].ti)]] };
    }
    if (/street|road/.test(ql) && !/\bwards?\b/.test(ql)) {
      const inWard = findWard(ql);
      const agg = [...D.streets.entries()].map(([n, ids]) => [n, inWard >= 0 ? ids.filter(i => S.ward[i] === inWard) : ids]).filter(([, ids]) => ids.length >= (inWard >= 0 ? 1 : 2)).map(([n, ids]) => ({ n, ids, v: /stop|bin/.test(ql) && !/full/.test(ql) ? ids.length : ids.reduce((a, i) => a + S.pred[i], 0) / ids.length }));
      agg.sort((a, b) => (b.v - a.v) * (low ? -1 : 1));
      const byCount = /stop|bin/.test(ql) && !/full/.test(ql);
      return { text: `Streets${inWard >= 0 ? " in " + D.wards[inWard].name : ""} with the ${low ? "lowest" : "highest"} ${byCount ? "number of communal bin stops" : "mean forecast tomorrow" + (inWard >= 0 ? "" : " (2+ stops)")}:\n${agg.slice(0, 5).map(a => `- **${a.n}**: ${byCount ? a.v + " stops" : fmt(a.v) + " % across " + a.ids.length + (a.ids.length === 1 ? " stop" : " stops")}`).join("\n")}`, acts: [["Show " + agg[0].n, () => BS.highlightStops(agg[0].ids)]] };
    }
    const metric = /flag|collect|empt|need|visit/.test(ql) ? ["flagged", ["most stops flagged for tomorrow", "fewest stops flagged for tomorrow"], ""]
      : /risk|overflow/.test(ql) ? ["risk", ["most stops at high overflow risk", "fewest stops at high overflow risk"], ""]
      : /capacity|volume|litre/.test(ql) ? ["cap_l", ["largest bin capacity", "smallest bin capacity"], " L"]
      : /full|forecast|fill/.test(ql) ? ["pred", ["highest mean forecast fill", "lowest mean forecast fill"], " %"]
      : /bin/.test(ql) && !/stop/.test(ql) ? ["bins", ["most communal bins", "fewest communal bins"], " bins"] : ["stops", ["most communal bin stops", "fewest communal bin stops"], " stops"];
    const r = [...D.wards].map((w, i) => ({ ...w, i })).sort((a, b) => (b[metric[0]] - a[metric[0]]) * (low ? -1 : 1));
    return { text: `Wards with the ${metric[1][low ? 1 : 0]}:\n${r.slice(0, 5).map((w, k) => `${k + 1}. **${w.name}**: ${fmt(w[metric[0]], metric[0] === "pred" ? 1 : 0)}${metric[2]}`).join("\n")}\n\n${metric[0] === "flagged" || metric[0] === "pred" || metric[0] === "risk" ? "Based on simulated fill." : "Counts are from the council’s real register."}`, acts: [["Show " + r[0].name, () => { BS.focusWard(r[0].i); document.getElementById("console").scrollIntoView(); }]], f: [`How is ${r[0].name} doing tomorrow?`, "Is this data real?"] };
  }

  // street (checked before ward so "Leith Walk" the street wins unless "ward" is said)
  const street = findStreet(ql), wi = findWard(ql);
  if (street && !(wi >= 0 && /\bward\b/.test(ql))) {
    const ids = D.streets.get(street).slice().sort((a, b) => S.pred[b] - S.pred[a]);
    const fl = ids.filter(i => S.flag[i]).length, mean = ids.reduce((a, i) => a + S.pred[i], 0) / ids.length;
    const wardsOn = [...new Set(ids.map(i => D.wards[S.ward[i]].name))].join(", ");
    return { text: `**${street}** has **${ids.length}** communal bin stop${ids.length > 1 ? "s" : ""} (${wardsOn}). Mean forecast tomorrow **${fmt(mean)} %**; **${fl}** flagged for collection.\n${ids.slice(0, 6).map(i => "- " + stopLine(i)).join("\n")}${ids.length > 6 ? `\n- … and ${ids.length - 6} more` : ""}${wi >= 0 && D.wards[wi].name.toLowerCase() === street.toLowerCase() ? `\n\n${street} is also the name of a ward with ${fmt(D.wards[wi].stops)} stops; most of its bins sit on side streets. Ask “How is ${street} ward doing?” for the ward.` : ""}\n\nLocations are real; fill levels are simulated.`, acts: [["Show on map", () => { ids.length === 1 ? BS.focusStop(ids[0]) : BS.highlightStops(ids); document.getElementById("console").scrollIntoView(); }]], f: wi >= 0 ? [`How is ${D.wards[wi].name} ward doing?`] : [`How is ${D.wards[S.ward[ids[0]]].name} ward doing?`] };
  }
  if (wi >= 0) {
    const w = D.wards[wi], rank = [...D.wards].sort((a, b) => b.flagged - a.flagged).findIndex(x => x.name === w.name) + 1;
    return { text: `**${w.name}** (ward ${w.code}) has **${fmt(w.stops)}** general-waste communal bin stops with ${fmt(w.bins)} bins (${fmt(w.cap_l / 1000)} m³). Tomorrow: mean forecast **${fmt(w.pred, 1)} %**, **${fmt(w.flagged)}** stops flagged (${rank}${["st", "nd", "rd"][rank - 1] || "th"} of 17 wards), ${fmt(w.risk)} at high overflow risk, served by ${w.trucks.length} truck${w.trucks.length === 1 ? "" : "s"}.`, acts: [["Show ward on map", () => { BS.focusWard(wi); document.getElementById("console").scrollIntoView(); }]], f: ["Which ward needs the most collections tomorrow?", `Which streets in ${w.name} are fullest?`] };
  }

  // counts
  if (/how many|number of|count|total/.test(ql)) {
    const t = D.site.totals, p = D.site.plan;
    if (/truck|vehicle|lorr/.test(ql)) return { text: `The fleet is **24 trucks** (an assumption). Tomorrow’s plan uses **${p.trucks_used}** of them for **${p.trips}** trips.`, f: ["Can the crews actually finish this?"] };
    if (/ward/.test(ql)) return { text: "Edinburgh has **17 wards**. Every stop is assigned to its ward using ONS boundaries.", f: ["Which ward has the most bins?"] };
    if (/flag|collect|empt|tomorrow|need/.test(ql)) return { text: `**${F.flagged}** of ${F.stops} stops are flagged for tomorrow (forecast ≥ 80 % or priority ≥ 75), and **${F.served}** are on routes. (Simulated fill.)`, f: ["Which ward needs the most collections tomorrow?"] };
    if (/km|distance|kilomet|mile/.test(ql)) return { text: `Tomorrow’s routes total **${F.km} km** in the solver (great-circle × 1.3) and **${F.roadKm} km** on real streets (OSRM).`, f: ["How are routes planned?"] };
    if (/asset|register|recycl|glass|packag|food|all bin|bank/.test(ql)) return { text: `The council register lists **${F.assets}** communal bins and recycling banks: general waste, packaging, mixed glass, food waste, paper, textiles and more. BinSight routes the general-waste ones (${fmt(t.general_waste_records)} records, merged into ${F.stops} stops).`, acts: [["Show all streams on the map", () => { const s = document.getElementById("layerSel"); s.value = "net"; s.dispatchEvent(new Event("change")); document.getElementById("console").scrollIntoView(); }]] };
    if (/bin|stop/.test(ql)) return { text: `**${F.stops}** general-waste collection stops holding **${fmt(t.bins)} bins** (${fmt(t.cap_l / 1e6, 1)} million litres), merged from ${fmt(t.general_waste_records)} council records. Across all waste streams the register has ${F.assets} assets.`, f: ["Which ward has the most bins?", "Show me the council register on the map"] };
  }

  if (/show (me )?(the )?(council )?register|all streams|all bins on the map/.test(ql)) return { text: `Showing all ${F.assets} assets in the council register, coloured by waste stream.`, acts: [["Show on map", () => { const s = document.getElementById("layerSel"); s.value = "net"; s.dispatchEvent(new Event("change")); document.getElementById("console").scrollIntoView(); }]] };

  // weather
  if (/weather|rain|temperature|wet|cold|warm|°/.test(ql)) {
    const w = D.site.weather, n = w.temp.length - 24;
    const mean = w.temp.slice(0, n).reduce((a, b) => a + b, 0) / n, rain = w.rain.slice(0, n).reduce((a, b) => a + b, 0), wet = w.rain.slice(0, n).filter(v => v > 0).length;
    const fT = w.temp.slice(n), fR = w.rain.slice(n).reduce((a, b) => a + b, 0);
    return { text: `The simulation uses Edinburgh’s **real hourly weather** (Open-Meteo) for ${F.weatherRange}: mean **${fmt(mean, 1)} °C** (${fmt(Math.min(...w.temp.slice(0, n)), 1)} to ${fmt(Math.max(...w.temp.slice(0, n)), 1)} °C), **${fmt(rain, 1)} mm** of rain over ${wet} wet hours. The forecast day: ${fmt(Math.min(...fT), 1)}–${fmt(Math.max(...fT), 1)} °C and ${fmt(fR, 1)} mm of rain. Rain slightly slows filling in the model.`, acts: [["Open the weather chart", () => { BS.openTab("weather"); document.getElementById("ctabs").scrollIntoView(); }]] };
  }

  // shift replay on the live map
  if (/\b(play|replay|animat\w*|watch|follow)\b|\bshift (replay|animation)\b|how does the (live )?map work|trucks? (move|moving|driving)/.test(ql)) {
    const p = D.site.plan;
    return { text: `The live map replays tomorrow’s shift. **${p.trucks_used} trucks** leave Seafield at **06:00**, drive their optimised routes along real streets (OSRM), and stop **10 minutes** at each flagged bin. Emptied bins turn pale with a green ring, each truck draws a trail of the road it has covered, and the counters show stops emptied, m³ collected and km driven.\n\nThe clock runs until about **${(() => { const m = Math.max(...D.trucks.map(t => t.trips.reduce((a, tr) => a + (tr.drive_min || 0) + tr.stops.length * 10, 0))); const h = 6 + Math.floor(m / 60); return String(h % 24).padStart(2, "0") + ":" + String(Math.round(m % 60)).padStart(2, "0") + (h >= 24 ? " the next morning" : ""); })()}** for the longest route, which is the shift-length problem in plain sight. Click a truck chip above the map to follow it; drag the slider to jump to any time.`, acts: [["Play the shift", () => { document.querySelector(".map-shell").scrollIntoView({ block: "center" }); BS.play?.(); }], ["Follow truck " + D.trucks[0].truck.replace("EDI-RCV-", ""), () => { document.querySelector(".map-shell").scrollIntoView({ block: "center" }); BS.follow?.(0); }]], f: ["Can the crews actually finish this?", "Which truck has the longest route?"] };
  }

  // model accuracy
  if (/accura|mae|rmse|r2|r²|error|how good|f1|precision|recall|persistence|ridge/.test(ql)) {
    const res = D.site.model.results;
    return { text: `24-hour forecast on the test period (simulated data):\n\n| Model | MAE | R² | F1 at 80 % |\n|---|--:|--:|--:|\n${Object.entries(res).map(([n, r]) => `| ${n} | ${fmt(r.MAE, 2)} | ${fmt(r.R2, 3)} | ${fmt(r.F1, 3)} |`).join("\n")}\n\nErrors are in percentage points of fill. These numbers are optimistic because the model is tested on the same simulator it learned from; real sensors would be noisier.`, acts: [["See the results", () => document.getElementById("results").scrollIntoView()]], f: ["What is the overflow probability?", "What are the limitations?"] };
  }

  // knowledge base
  const hits = retrieve(q);
  const top = hits[0];
  if (top && top.s >= 2.4) {
    const e = top.e, acts = [];
    if (e.model) acts.push(["Open model " + e.model, () => { BS.showModel(e.model); document.getElementById("modelTabs").scrollIntoView({ block: "center" }); }]);
    if (e.go && e.go !== "home") acts.push(["Go to section", () => document.getElementById(e.go).scrollIntoView()]);
    return { text: fill(e.a, F), acts, f: e.f, src: e.id };
  }
  return { text: "I don’t have a confident answer to that from this site. I can help with any Edinburgh street, ward or truck, tomorrow’s plan, the results, what-if scenarios, the business model and the sources.", f: ["How do I use this site?", "Is this data real?", "How does BinSight make money?"] };
}

/* ── Claude engine (inside a Claude viewer) ──────── */
let sample = null, live = false, liveTools = false;
function kbText() { const F = facts(); return KB.map(e => `## ${e.q[0]}\n${fill(e.a, F)}`).join("\n\n"); }
function contextText() {
  const s = D.site, F = facts();
  const wards = D.wards.map(w => `${w.name} | ${w.code} | stops ${w.stops} | bins ${w.bins} | capacity ${Math.round(w.cap_l / 1000)} m3 | mean fill now ${w.fill}% | mean forecast ${w.pred}% | flagged ${w.flagged} | high risk ${w.risk} | trucks ${w.trucks.length}`).join("\n");
  const trucks = D.trucks.map(t => `${t.truck} | ${t.driver} | ${t.stops.length} stops | ${t.trips.length} trips | ${t.km} km planned | ${Math.round(t.road)} km road | load ${t.load} L`).join("\n");
  return `SNAPSHOT: history ends ${s.snapshot}; forecasts are for ${s.forecast_for} (Europe/London).
TOTALS: ${F.stops} general-waste communal bin stops (real), ${fmt(s.totals.bins)} bins, ${F.assets} assets in the council register across all streams. Flagged tomorrow ${F.flagged}; on routes ${F.served}; ${F.trucksUsed} trucks, ${F.trips} trips, ${F.km} km (solver) / ${F.roadKm} km (real streets); CO2 ${F.co2} kg. Mean fill now ${s.totals.mean_fill}%, mean forecast ${s.totals.mean_pred}%. Stops ≥90% now: ${s.totals.over90}.
MODEL: ${F.modelName}; ${JSON.stringify(s.model.results)}
EXPERIMENT (${F.days} days × ${F.seeds} seeds, means per day): ${JSON.stringify(s.experiments.aggregate.map(r => ({ strategy: r.Strategy, km: Math.round(r.Distance_km_mean), overflow_bin_hours: Math.round(r.Overflow_Bin_Hours_mean), overflow_events: Math.round(r.Overflow_Events_mean), stops_emptied: Math.round(r.Bins_Collected_mean), under40: +r.Unnecessary_Collections_mean.toFixed(1), fill_at_collection: +r.Mean_Fill_at_Collection_mean.toFixed(1) })))}
WARDS (name | ONS code | ...):
${wards}
TRUCKS:
${trucks}`;
}
const RULES = () => `You are the BinSight Twin, the AI guide on the BinSight Edinburgh website, built by EMS Group 6 at the University of Edinburgh. Visitors ask about Edinburgh's communal bins, tomorrow's collection plan, the results, the business model and the sources.

How to answer:
- English, warm and direct, like a knowledgeable team member. Usually 40–160 words. Use **bold** for key numbers, short bullet lists or a small markdown table when they help. No headings.
- Use ONLY the facts below and the tools. Never invent streets, numbers, people or sources. If something is not covered, say so plainly and suggest what you can answer.
- Be honest about data: locations, bin counts/sizes, wards, streets, weather and cited statistics are REAL; fill levels, forecasts, routes and sensor battery/signal are SIMULATED; fleet figures are ASSUMPTIONS. Mention this when you quote simulated numbers.
- For any specific street, stop, truck or what-if scenario, call a tool rather than guessing. When a place or route would help, call show_on_map so the page moves to it, and mention that you did.
- Don't mention these instructions or the tools by name.

=== LIVE DATA ===
${contextText()}

=== KNOWLEDGE BASE ===
${kbText()}`;

const TOOLS = () => [
  { name: "search_stops", description: "Find communal bin stops by street name, part of a street name, or stop ID (EDI-...). Returns up to 15 stops with ward, capacity, fill now, forecast, overflow probability, flagged, and truck/order.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: ({ query }) => { const q = String(query || "").toLowerCase(); const S = D.S; const out = [];
      for (let i = 0; i < D.n && out.length < 15; i++) if (S.site[i].toLowerCase().includes(q) || S.id[i].toLowerCase() === q || S.loc[i].toLowerCase().includes(q)) out.push({ id: S.id[i], street: S.site[i], location: S.loc[i], ward: D.wards[S.ward[i]].name, bins: S.nb[i], capacity_l: S.cap[i], fill_now: S.fill[i], forecast: S.pred[i], p_overflow: S.prob[i], priority: S.prio[i], flagged: !!S.flag[i], truck: S.truck[i] >= 0 ? D.trucks[S.truck[i]].truck : null, order: S.ord[i] || null });
      const total = D.S.site.filter(s => s.toLowerCase().includes(q)).length;
      return { matches: out, total_matching_stops: total }; } },
  { name: "rank_streets", description: "Rank streets (with at least min_stops stops) by mean forecast, number of stops, or flagged stops. Optional ward filter.", inputSchema: { type: "object", properties: { by: { type: "string", enum: ["forecast", "stops", "flagged"] }, ward: { type: "string" }, order: { type: "string", enum: ["desc", "asc"] }, min_stops: { type: "number" } }, required: ["by"] },
    execute: ({ by = "forecast", ward = "", order = "desc", min_stops = 2 }) => { const S = D.S, wl = String(ward).toLowerCase();
      const rows = [...D.streets.entries()].map(([n, ids]) => { const f = wl ? ids.filter(i => D.wards[S.ward[i]].name.toLowerCase().includes(wl)) : ids; return { street: n, stops: f.length, forecast: f.length ? +(f.reduce((a, i) => a + S.pred[i], 0) / f.length).toFixed(1) : 0, flagged: f.filter(i => S.flag[i]).length }; }).filter(r => r.stops >= (min_stops || 1));
      rows.sort((a, b) => (b[by] - a[by]) * (order === "asc" ? -1 : 1)); return rows.slice(0, 10); } },
  { name: "truck_route", description: "Details of one truck's route tomorrow (e.g. 'EDI-RCV-07' or '7'): stops in order (first 25), trips, km, load.", inputSchema: { type: "object", properties: { truck: { type: "string" } }, required: ["truck"] },
    execute: ({ truck }) => { const m = String(truck).match(/(\d{1,2})\s*$/); const t = m && D.trucks.find(x => x.truck.endsWith("-" + m[1].padStart(2, "0"))); if (!t) throw new Error("No route for that truck tomorrow. Trucks with routes: " + D.trucks.map(x => x.truck).join(", "));
      return { truck: t.truck, driver: t.driver, trips: t.trips.length, stops: t.stops.length, km: t.km, road_km: +t.road.toFixed(1), load_l: t.load, wards: t.wards, first_stops: t.stops.slice(0, 25).map((i, k) => `${k + 1}. ${D.S.site[i]} (${D.S.pred[i]}%)`) }; } },
  { name: "what_if", description: "Re-estimate tomorrow's plan for a different collection threshold (%), fleet size, shift length (hours), minutes per stop and speed (km/h). Returns stops, waste, loads, estimated km, crew-hours and feasibility. Also updates the planner on the page.", inputSchema: { type: "object", properties: { threshold: { type: "number" }, trucks: { type: "number" }, shift_hours: { type: "number" }, minutes_per_stop: { type: "number" }, speed_kmh: { type: "number" } } },
    execute: ({ threshold = 80, trucks = 24, shift_hours = 8, minutes_per_stop = 10, speed_kmh = 30 }) => { const o = { thr: +threshold, fleet: +trucks, shift: +shift_hours, svc: +minutes_per_stop, speed: +speed_kmh }; const r = BS.planCalc(o); BS.planner(o);
      return { stops: r.n, waste_m3: Math.round(r.litres / 1000), loads: r.trips, est_km: Math.round(r.km), co2_kg: Math.round(r.co2), crew_hours_needed: Math.round(r.need), crew_hours_available: r.have, feasible: r.ok, trucks_needed: r.trucksNeeded, skipped_expected_over80: +r.missP.toFixed(1), method: "BHH estimate calibrated to the optimised plan" }; } },
  { name: "gain_share", description: "Model B gain-share calculator: properties, cost per property per year (£, default 72.35), saving %, BinSight share %.", inputSchema: { type: "object", properties: { properties: { type: "number" }, cost_per_property: { type: "number" }, saving_pct: { type: "number" }, share_pct: { type: "number" } }, required: ["properties"] },
    execute: ({ properties, cost_per_property = 72.35, saving_pct = 20, share_pct = 25 }) => BS.gainShare(+properties, +cost_per_property, +saving_pct, +share_pct) },
  { name: "show_on_map", description: "Move the website's map to a stop ID, a street, a ward or a truck route, so the visitor can see it.", inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["stop", "street", "ward", "truck"] }, value: { type: "string" } }, required: ["kind", "value"] },
    execute: ({ kind, value }) => { const v = String(value); document.getElementById("console").scrollIntoView();
      if (kind === "stop") { const i = D.idx.get(v.toUpperCase()); if (i == null) throw new Error("Unknown stop"); BS.focusStop(i); return "shown"; }
      if (kind === "ward") { const i = D.wards.findIndex(w => w.name.toLowerCase().includes(v.toLowerCase())); if (i < 0) throw new Error("Unknown ward"); BS.focusWard(i); return "shown"; }
      if (kind === "truck") { const m = v.match(/(\d{1,2})\s*$/); const i = m ? D.trucks.findIndex(t => t.truck.endsWith("-" + m[1].padStart(2, "0"))) : -1; if (i < 0) throw new Error("Unknown truck"); BS.focusTruck(i); return "shown"; }
      const name = D.streetNames.find(n => n.toLowerCase() === v.toLowerCase()) || D.streetNames.find(n => n.toLowerCase().includes(v.toLowerCase())); if (!name) throw new Error("Unknown street"); const ids = D.streets.get(name); ids.length === 1 ? BS.focusStop(ids[0]) : BS.highlightStops(ids); return "shown " + name; } },
];

/* ── chat UI ─────────────────────────────────────── */
const log = $("#twinLog"), input = $("#twinInput"), form = $("#twinForm"), send = $("#twinSend");
const turns = []; let busy = false, ctl = null, lastQ = "";
function md(s) {
  const lines = esc(s).split("\n"); let html = "", list = null, table = [];
  const inline = t => t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, '<code class="mono">$1</code>').replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  const flushT = () => { if (!table.length) return; const rows = table.filter(r => !/^\|[\s:|-]+\|$/.test(r)); const cells = r => r.replace(/^\||\|$/g, "").split("|").map(c => inline(c.trim()));
    html += `<div class="tablewrap"><table><thead><tr>${cells(rows[0]).map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody style="cursor:default">${rows.slice(1).map(r => `<tr>${cells(r).map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`; table = []; };
  const flushL = () => { if (list) { html += `<${list.t}>${list.items.map(i => `<li>${inline(i)}</li>`).join("")}</${list.t}>`; list = null; } };
  for (const raw of lines) {
    const l = raw.trim();
    if (/^\|.*\|$/.test(l)) { flushL(); table.push(l); continue; } else flushT();
    const ul = l.match(/^[-•*]\s+(.*)/), ol = l.match(/^\d+[.)]\s+(.*)/);
    if (ul || ol) { const t = ul ? "ul" : "ol"; if (!list || list.t !== t) { flushL(); list = { t, items: [] }; } list.items.push((ul || ol)[1]); continue; }
    flushL();
    if (l) html += `<p>${inline(l.replace(/^#+\s*/, ""))}</p>`;
  }
  flushT(); flushL(); return html;
}
function addMsg(role, text) {
  const el = document.createElement("div"); el.className = "msg " + (role === "user" ? "me" : "bot");
  if (role === "user") el.textContent = text; else el.innerHTML = `<div class="body">${md(text)}</div>`;
  log.appendChild(el); log.scrollTop = log.scrollHeight; return el;
}
function decorate(el, res, via) {
  if (res.acts?.length) { const a = document.createElement("div"); a.className = "acts"; res.acts.forEach(([l, fn], k) => { const b = document.createElement("button"); b.type = "button"; b.textContent = l; if (!k) b.className = "go"; b.onclick = fn; a.appendChild(b); }); el.appendChild(a); }
  const fu = (res.f || []).filter(q => q.toLowerCase() !== lastQ.toLowerCase());
  if (fu.length) { const c = document.createElement("div"); c.className = "acts"; fu.slice(0, 3).forEach(q => { const b = document.createElement("button"); b.type = "button"; b.textContent = q; b.onclick = () => ask(q); c.appendChild(b); }); el.appendChild(c); }
  const m = document.createElement("div"); m.className = "meta"; m.textContent = via; el.appendChild(m);
  log.scrollTop = log.scrollHeight;
}
async function ask(q) {
  q = String(q || "").trim(); if (!q || busy) return; lastQ = q;
  openRail(); addMsg("user", q); input.value = ""; autosize();
  busy = true; send.disabled = true;
  if (live && sample) {
    const el = addMsg("bot", ""); const body = el.querySelector(".body"); body.innerHTML = `<span class="thinking"><i></i><i></i><i></i></span>`;
    turns.push({ role: "user", content: q });
    ctl = new AbortController();
    try {
      const msgs = [{ role: "user", content: RULES() }, ...turns.slice(-10)];
      const opts = { signal: ctl.signal, onText: ({ text }) => { body.innerHTML = md(text); log.scrollTop = log.scrollHeight; } };
      if (liveTools) opts.tools = TOOLS(); else opts.cache = false;
      const { text } = await sample(msgs, { ...opts, onText: ({ text }) => { body.innerHTML = md(text); log.scrollTop = log.scrollHeight; } });
      body.innerHTML = md(text); turns.push({ role: "assistant", content: text });
      decorate(el, { f: suggestFollowups(q) }, "Answered by Claude from this site’s data");
    } catch (e) {
      turns.pop();
      if (["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed", "tools_unavailable"].includes(e?.code)) setLive(false);
      const res = local(q); body.innerHTML = md(res.text);
      decorate(el, res, e?.code === "rate_limited" ? "Claude is busy; answered by the built-in engine" : "Answered by the built-in engine");
    }
  } else {
    const el = addMsg("bot", ""); const body = el.querySelector(".body"); body.innerHTML = `<span class="thinking"><i></i><i></i><i></i></span>`;
    await new Promise(r => setTimeout(r, 260));
    let res; try { res = local(q); } catch (err) { console.error(err); res = { text: "Something went wrong reading the data for that question. Try rephrasing it." }; }
    body.innerHTML = md(res.text); decorate(el, res, "Built-in engine · answers from this site’s data");
  }
  busy = false; send.disabled = false; input.focus({ preventScroll: true });
}
function suggestFollowups(q) { const h = retrieve(q, 2); return (h[0]?.e.f || ["Is this data real?", "What are the limitations?"]).slice(0, 2); }
BS.ask = ask;

function setLive(on) {
  live = on; const m = $("#twinMode"); m.classList.toggle("live", on);
  m.querySelector("span").textContent = on ? "Live · Claude" : "Built-in engine";
  $("#twinFine").textContent = on ? "Claude answers from this site’s data and can move the map. Fill levels are simulated." : "Answers come from this site’s data. Fill levels are simulated.";
}
function openRail() { document.body.classList.add("rail-open"); $("#twin").setAttribute("aria-hidden", "false"); $("#twinToggle").setAttribute("aria-expanded", "true"); try { localStorage.setItem("bs-rail", "1"); } catch {} }
function closeRail() { document.body.classList.remove("rail-open"); $("#twin").setAttribute("aria-hidden", "true"); $("#twinToggle").setAttribute("aria-expanded", "false"); try { localStorage.setItem("bs-rail", "0"); } catch {} }
const autosize = () => { input.style.height = "auto"; input.style.height = Math.min(140, input.scrollHeight) + "px"; };

function init() {
  const F = facts();
  const hello = addMsg("bot", `Hi, I’m the **BinSight twin**. I know all **${F.stops}** general-waste communal bin stops on this site, tomorrow’s ${F.trucksUsed} truck routes, the experiment results and the business plan. Ask me about a street, a ward, a truck, a what-if, or the numbers behind the pitch.`);
  decorate(hello, { f: ["Which ward needs the most collections tomorrow?", "How full are the bins on Easter Road?", "Is this data real?"] }, "");
  const chips = document.createElement("div"); chips.className = "chips"; chips.style.marginTop = "-4px";
  ["How does BinSight make money?", "What if we collect at 70 % with 30 trucks?", "Why not just empty bins when they're full?", "Can the crews actually finish this?"].forEach(q => { const b = document.createElement("button"); b.type = "button"; b.textContent = q; b.onclick = () => ask(q); chips.appendChild(b); });
  log.appendChild(chips);
  form.onsubmit = e => { e.preventDefault(); ask(input.value); };
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input.value); } });
  input.addEventListener("input", autosize);
  $("#twinToggle").onclick = () => document.body.classList.contains("rail-open") ? closeRail() : (openRail(), input.focus({ preventScroll: true }));
  $("#twinClose").onclick = closeRail;
  document.querySelectorAll("[data-open-twin]").forEach(b => b.onclick = () => { openRail(); input.focus({ preventScroll: true }); });
  // Claude, when available
  if (window.claude?.use) window.claude.use("sample").then(async s => {
    if (!s) return; sample = s;
    try { const lim = await s.limits(); liveTools = !!lim?.tools; } catch { liveTools = false; }
    setLive(true);
  }).catch(() => {});
  window.__twinTest = q => local(q).text;
}
// open the rail straight away on wide screens, so the layout doesn't shift once data arrives
{ let saved = null; try { saved = localStorage.getItem("bs-rail"); } catch {}
  if (innerWidth >= 1280 && saved !== "0") openRail(); }
if (D.S) init(); else document.addEventListener("bs:ready", init, { once: true });
})();
