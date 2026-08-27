import http from "node:http";

const PORT = process.env.PORT || 3000;

const FPL_URL =
  "https://fantasy.premierleague.com/api/bootstrap-static/";

const ENTRY_URL =
  "https://fantasy.premierleague.com/api/entry/";

const STANDINGS_URL =
  "https://fantasy.premierleague.com/api/leagues-classic/314/standings/";



// Check for a newly completed gameweek every 5 minutes.
const REFRESH_INTERVAL = 5 * 60 * 1000;


// ==================================================
// RANK TIERS
// ==================================================

const SAMPLING_BANDS = [
  { name: "1-10000", min: 1, max: 10000, sampleSize: 10 },

  { name: "10001-50000", min: 10001, max: 50000, sampleSize: 15 },

  { name: "50001-100000", min: 50001, max: 100000, sampleSize: 20 },

  { name: "100001-250000", min: 100001, max: 250000, sampleSize: 25 },

  { name: "250001-500000", min: 250001, max: 500000, sampleSize: 30 },

  { name: "500001-1000000", min: 500001, max: 1000000, sampleSize: 35 },

  { name: "1000001-2000000", min: 1000001, max: 2000000, sampleSize: 40 },

  { name: "2000001-3000000", min: 2000001, max: 3000000, sampleSize: 45 },

  { name: "3000001-4000000", min: 3000001, max: 4000000, sampleSize: 50 },

  { name: "4000001-5000000", min: 4000001, max: 5000000, sampleSize: 55 },

  { name: "5000001+", min: 5000001, max: Infinity, sampleSize: 60 }
];

// ==================================================
// CACHE
// ==================================================

const cache = {
  latestGameweek: null,
  latestResult: null,

  // Keep previous completed GWs available internally.
  previousResults: {},

  // Prevent two refresh jobs running together.
  refreshing: false,

  lastRefreshAttempt: null,
  lastSuccessfulRefresh: null,
  lastError: null
};


// ==================================================
// RESPONSE HELPER
// ==================================================

function sendJSON(res, status, data) {
  res.writeHead(status);
  res.end(JSON.stringify(data));
}


// ==================================================
// FETCH WITH TIMEOUT
// ==================================================

async function fetchJSON(url, timeoutMs = 15000) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    return await response.json();

  } finally {
    clearTimeout(timeout);
  }
}


// ==================================================
// GET CURRENT FPL DATA
// ==================================================

async function getFPLData() {
  return await fetchJSON(FPL_URL);
}


// ==================================================
// FIND LATEST COMPLETED GAMEWEEK
// ==================================================

function getLatestCompletedGameweek(data) {
  const completedEvents =
    data.events.filter(
      event => event.finished === true
    );

  if (completedEvents.length === 0) {
    return null;
  }

  return completedEvents[
    completedEvents.length - 1
  ].id;
}


// ==================================================
// GET STANDINGS PAGE
// ==================================================

async function getStandingsPage(page) {
  return await fetchJSON(
    `${STANDINGS_URL}?page_standings=${page}`
  );
}


// ==================================================
// GET 10 MANAGERS FROM A RANK TIER
// ==================================================
// ==================================================
// ==================================================
// FIND STANDINGS PAGE FOR A RANK
// ==================================================

function getStandingsPageForRank(rank) {
  return Math.ceil(rank / 50);
}
// ==================================================
// RANDOM INTEGER
// ==================================================

function randomInteger(min, max) {
  return Math.floor(
    Math.random() * (max - min + 1)
  ) + min;
}
// ==================================================
// GENERATE RANDOM TARGET RANKS
// ==================================================


  const availableManagers =
    actualMax - band.min + 1;

  const targetCount =
    Math.min(
      band.sampleSize,
      availableManagers
    );

  const ranks = new Set();

  while (ranks.size < targetCount) {

    ranks.add(
      randomInteger(
        band.min,
        actualMax
      )
    );
  }


// ==================================================
// GET RANDOM SAMPLE MANAGERS FOR BAND
// ==================================================

async function getSampleManagersForBand(
  band,
  totalManagers
) {

  const managersById = new Map();

  const maxRank =
    band.max === Infinity
      ? totalManagers
      : Math.min(
          band.max,
          totalManagers
        );

  // Keep trying random pages until we have enough managers
  // or until 10 pages have been attempted.
  const attemptedPages = new Set();

  while (
    managersById.size < band.sampleSize &&
    attemptedPages.size < 10
  ) {

    // Pick a random rank inside this band
    const randomRank =
      randomInteger(
        band.min,
        maxRank
      );

    const page =
      getStandingsPageForRank(
        randomRank
      );

    // Don't request the same page twice
    if (attemptedPages.has(page)) {
      continue;
    }

    attemptedPages.add(page);

    console.log(
      `Band ${band.name}: fetching random page ${page}`
    );

    try {

      const data =
        await getStandingsPage(page);

      const managers =
        data.standings?.results || [];

      for (const manager of managers) {

        if (
          manager.rank >= band.min &&
          manager.rank <= maxRank
        ) {

          managersById.set(
            manager.entry,
            manager
          );

        }

      }

      console.log(
        `Band ${band.name}: ${managersById.size}/${band.sampleSize} managers`
      );

    } catch (error) {

      console.error(
        `Failed to fetch standings page ${page}:`,
        error.message
      );
    }
  }

  return [
    ...managersById.values()
  ].slice(
    0,
    band.sampleSize
  );
}
// GET ONE MANAGER'S GW PICKS
// ==================================================

async function getManagerPicks(
  managerId,
  gameweek
) {
  return await fetchJSON(
    `https://fantasy.premierleague.com/api/entry/${managerId}/event/${gameweek}/picks/`
  );
}


// ==================================================// ==================================================
// ANALYZE ONE SAMPLING BAND
// ==================================================

async function analyzeBand(
  band,
  gameweek,
  totalManagers
) {

  console.log(
    `Building band ${band.name}`
  );

  console.log(
    `Target sample size: ${band.sampleSize}`
  );

  const managers =
    await getSampleManagersForBand(
      band,
      totalManagers
    );

  const results = [];

  const ownership = {};
  const captaincy = {};
  const tripleCaptaincy = {};

  // --------------------------------------------------
  // Fetch GW picks for sampled managers
  // --------------------------------------------------

  for (const manager of managers) {

    try {

      const picksData =
        await getManagerPicks(
          manager.entry,
          gameweek
        );

      const picks =
        picksData.picks || [];


      // ----------------------------------------------
      // CAPTAIN
      // ----------------------------------------------

      const captain =
        picks.find(
          pick =>
            pick.is_captain === true
        );


      // ----------------------------------------------
      // TRIPLE CAPTAIN
      // ----------------------------------------------

      const tripleCaptain =
        picks.find(
          pick =>
            pick.is_captain === true &&
            pick.multiplier === 3
        );


      // ----------------------------------------------
      // OWNERSHIP
      // ----------------------------------------------

      for (const pick of picks) {

        const playerId =
          String(pick.element);

        ownership[playerId] =
          (ownership[playerId] || 0) + 1;
      }


      // ----------------------------------------------
      // CAPTAINCY
      // ----------------------------------------------

      if (captain) {

        const playerId =
          String(captain.element);

        captaincy[playerId] =
          (captaincy[playerId] || 0) + 1;
      }


      // ----------------------------------------------
      // TRIPLE CAPTAINCY
      // ----------------------------------------------

      if (tripleCaptain) {

        const playerId =
          String(tripleCaptain.element);

        tripleCaptaincy[playerId] =
          (tripleCaptaincy[playerId] || 0) + 1;
      }


      // ----------------------------------------------
      // STORE MANAGER
      // ----------------------------------------------

      results.push({

        rank:
          manager.rank,

        managerId:
          manager.entry,

        managerName:
          manager.player_name,

        teamName:
          manager.entry_name,

        overallPoints:
          manager.total,

        activeChip:
          picksData.active_chip ?? null,

        captain:
          captain
            ? captain.element
            : null,

        tripleCaptain:
          tripleCaptain
            ? tripleCaptain.element
            : null,

        picks
      });

    } catch (error) {

      console.error(
        `Manager ${manager.entry} failed:`,
        error.message
      );

      results.push({

        rank:
          manager.rank,

        managerId:
          manager.entry,

        error:
          error.message
      });
    }
  }


  // ==================================================
  // SUCCESSFUL MANAGERS
  // ==================================================

  const successfulManagers =
    results.filter(
      manager =>
        Array.isArray(manager.picks)
    );

  const successfulSampleSize =
    successfulManagers.length;


  // ==================================================
  // PERCENTAGES
  // ==================================================

  const ownershipPercent = {};
  const captaincyPercent = {};
  const tripleCaptainPercent = {};


  if (successfulSampleSize > 0) {

    for (
      const [playerId, count]
      of Object.entries(ownership)
    ) {

      ownershipPercent[playerId] =
        Number(
          (
            count /
            successfulSampleSize *
            100
          ).toFixed(1)
        );
    }


    for (
      const [playerId, count]
      of Object.entries(captaincy)
    ) {

      captaincyPercent[playerId] =
        Number(
          (
            count /
            successfulSampleSize *
            100
          ).toFixed(1)
        );
    }


    for (
      const [playerId, count]
      of Object.entries(tripleCaptaincy)
    ) {

      tripleCaptainPercent[playerId] =
        Number(
          (
            count /
            successfulSampleSize *
            100
          ).toFixed(1)
        );
    }
  }


  // ==================================================
  // RETURN BAND DATA
  // ==================================================

  return {

    band:
      band.name,

    rankRange: {

      min:
        band.min,

      max:
        band.max === Infinity
          ? null
          : band.max
    },

    requestedSampleSize:
      band.sampleSize,

    successfulSampleSize,

    managers:
      results,

    ownership,
    ownershipPercent,

    captaincy,
    captaincyPercent,

    tripleCaptaincy,
    tripleCaptainPercent
  };
}
// ==================================================
// BUILD COMPLETE GAMEWEEK RESULT
// ==================================================

// ==================================================
// BUILD COMPLETE MEGA CACHE FOR GAMEWEEK
// ==================================================

async function buildGameweekResult(gameweek) {

  console.log(
    "========================================"
  );

  console.log(
    `BUILDING MEGA CACHE FOR GW ${gameweek}`
  );

  console.log(
    "========================================"
  );


  // --------------------------------------------------
  // Get current total number of FPL managers.
  // --------------------------------------------------

  const fplData =
    await getFPLData();

  const totalManagers =
  Number(
    fplData.total_players
  );


  if (
    !Number.isFinite(totalManagers) ||
    totalManagers <= 0
  ) {

    throw new Error(
      "Could not determine total number of FPL managers."
    );
  }


  console.log(
    "Total managers:",
    totalManagers
  );


  // --------------------------------------------------
  // Build every sampling band.
  // --------------------------------------------------

  const bands = [];


  for (const band of SAMPLING_BANDS) {

    const result =
      await analyzeBand(
        band,
        gameweek,
        totalManagers
      );

    bands.push(result);
  }


  // --------------------------------------------------
  // Return complete mega cache.
  // --------------------------------------------------

  return {

    season:
      "2026/27",

    gameweek,

    totalManagers,

    bands,

    createdAt:
      new Date().toISOString()
  };
}
// ==================================================
// AUTOMATIC CACHE REFRESH
// ==================================================

async function refreshCache() {

  if (cache.refreshing) {

    console.log(
      "Refresh already running."
    );

    return;
  }


  cache.refreshing = true;

  cache.lastRefreshAttempt =
    new Date().toISOString();


  try {

    // ----------------------------------------------
    // STEP 1
    // Check FPL for latest completed GW.
    // ----------------------------------------------

    console.log(
      "Checking for completed gameweek..."
    );
const fplData =
  await getFPLData();

const latestGameweek =
  getLatestCompletedGameweek(
    fplData
  );

console.log(
  "Latest completed GW:",
  latestGameweek
);

console.log(
  "Event status:",
  fplData.events.map(event => ({
    id: event.id,
    finished: event.finished,
    is_current: event.is_current,
    is_next: event.is_next
  }))
);



    if (latestGameweek === null) {

      console.log(
        "No completed gameweek yet."
      );

      return;
    }


    // ----------------------------------------------
    // STEP 2
    // Nothing new?
    // Do absolutely nothing.
    // ----------------------------------------------

    if (
      cache.latestGameweek ===
      latestGameweek
    ) {

      console.log(
        `GW ${latestGameweek} already cached.`
      );

      return;
    }


    // ----------------------------------------------
    // STEP 3
    // NEW GAMEWEEK DETECTED.
    // ----------------------------------------------

    console.log(
      `NEW GAMEWEEK DETECTED: GW ${latestGameweek}`
    );


    // ----------------------------------------------
    // STEP 4
    // Fetch and calculate everything ONCE.
    // ----------------------------------------------

    const result =
      await buildGameweekResult(
        latestGameweek
      );


    // ----------------------------------------------
    // STEP 5
    // Only replace the live cache AFTER the
    // entire GW has successfully finished building.
    // ----------------------------------------------

    if (
      cache.latestGameweek !== null &&
      cache.latestResult !== null
    ) {

      cache.previousResults[
        cache.latestGameweek
      ] =
        cache.latestResult;
    }


    cache.latestGameweek =
      latestGameweek;

    cache.latestResult =
      result;

    cache.lastSuccessfulRefresh =
      new Date().toISOString();

    cache.lastError =
      null;


    console.log(
      `GW ${latestGameweek} CACHE READY`
    );


  } catch (error) {

    cache.lastError =
      error.message;

    console.error(
      "CACHE REFRESH FAILED:",
      error.message
    );

  } finally {

    cache.refreshing =
      false;
  }
}


// ==================================================
// START BACKGROUND REFRESH
// ==================================================

// This starts automatically when the server starts.
// It does NOT wait for a user request.

refreshCache();


// Then periodically check whether a NEW GW exists.

setInterval(
  refreshCache,
  REFRESH_INTERVAL
);


// ==================================================
// HTTP SERVER
// ==================================================

const server =
  http.createServer(
    async (req, res) => {

      res.setHeader(
        "Content-Type",
        "application/json"
      );

      res.setHeader(
        "Access-Control-Allow-Origin",
        "*"
      );


      // ==================================================
      // HEALTH CHECK
      // ==================================================

      if (
        req.method === "GET" &&
        req.url === "/"
      ) {

        sendJSON(
          res,
          200,
          {
            status:
              "ok",

            latestCompletedGameweek:
              cache.latestGameweek,

            cacheReady:
              cache.latestResult !== null,

            refreshing:
              cache.refreshing
          }
        );

        return;
      }


      // ==================================================
      // LATEST CACHED RESULT
      // ==================================================

      if (
        req.method === "GET" &&
        req.url === "/api/sample-tiers"
      ) {

        if (
          cache.latestResult === null
        ) {

          sendJSON(
            res,
            503,
            {
              error:
                "No cached completed gameweek yet."
            }
          );

          return;
        }


        // ----------------------------------------------
        // THIS DOES NOT FETCH FPL.
        // IT ONLY RETURNS THE CACHE.
        // ----------------------------------------------

        sendJSON(
          res,
          200,
          cache.latestResult
        );

        return;
      }


      // ==================================================
      // CACHE STATUS
      // ==================================================

      if (
        req.method === "GET" &&
        req.url === "/api/cache"
      ) {

        sendJSON(
          res,
          200,
          {

            latestGameweek:
              cache.latestGameweek,

            cacheReady:
              cache.latestResult !== null,

            refreshing:
              cache.refreshing,

            lastRefreshAttempt:
              cache.lastRefreshAttempt,

            lastSuccessfulRefresh:
              cache.lastSuccessfulRefresh,

            lastError:
              cache.lastError,

            storedHistoricalGameweeks:
              Object.keys(
                cache.previousResults
              ).map(Number)
          }
        );

        return;
      }
            // ==================================================
      // USER FPL ENTRY / GLOBAL RANK
      // ==================================================

      if (
        req.method === "GET" &&
        req.url.startsWith("/api/entry/")
      ) {

        const entryId =
          req.url.split("/api/entry/")[1]


        // Validate FPL ID
        if (
          !entryId ||
          !/^\d+$/.test(entryId)
        ) {

          sendJSON(
            res,
            400,
            {
              error:
                "Invalid FPL ID"
            }
          )

          return
        }


        try {

          const data =
            await fetchJSON(
              `${ENTRY_URL}${entryId}/`
            )


          sendJSON(
            res,
            200,
            {
              id:
                data.id,

              playerName:
                data.player_first_name +
                " " +
                data.player_last_name,

              teamName:
                data.name,

              overallRank:
                data.summary_overall_rank,

              overallPoints:
                data.summary_overall_points
            }
          )

        } catch (error) {

          sendJSON(
            res,
            502,
            {
              error:
                "Could not fetch FPL entry",

              details:
                error.message
            }
          )
        }

        return
      }


      // ==================================================
      // RAW FPL DATA
      //
      // Kept for debugging only.
      // The app should NOT use this endpoint.
      // ==================================================

      if (
        req.method === "GET" &&
        req.url === "/api/fpl"
      ) {

        try {

          const data =
            await getFPLData();

          sendJSON(
            res,
            200,
            data
          );

        } catch (error) {

          sendJSON(
            res,
            502,
            {
              error:
                error.message
            }
          );
        }

        return;
      }


      // ==================================================
      // OLD MANUAL TEST ROUTE
      // ==================================================

      if (
        req.method === "GET" &&
        req.url.startsWith(
          "/api/sample-tiers?gw="
        )
      ) {

        sendJSON(
          res,
          400,
          {
            error:
              "Manual gameweek fetching is disabled. The backend now automatically fetches and caches the latest completed gameweek."
          }
        );

        return;
      }


      // ==================================================
      // UNKNOWN ROUTE
      // ==================================================

      sendJSON(
        res,
        404,
        {
          error:
            "Not found"
        }
      );
    }
  );


// ==================================================
// START SERVER
// ==================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Server running on port ${PORT}`
    );
  }
);
