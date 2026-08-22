import http from "node:http";

const PORT = process.env.PORT || 3000;

const FPL_URL =
  "https://fantasy.premierleague.com/api/bootstrap-static/";

const STANDINGS_URL =
  "https://fantasy.premierleague.com/api/leagues-classic/314/standings/";

const SAMPLE_SIZE = 10;

// How often we check whether a new GW has finished.
const REFRESH_INTERVAL = 5 * 60 * 1000;


// ==================================================
// RANK TIERS
// ==================================================

const TIERS = [
  {
    name: "1-100",
    min: 1,
    max: 100
  },
  {
    name: "101-1000",
    min: 101,
    max: 1000
  },
  {
    name: "1001-10000",
    min: 1001,
    max: 10000
  },
  {
    name: "10001-100000",
    min: 10001,
    max: 100000
  },
  {
    name: "100001-1000000",
    min: 100001,
    max: 1000000
  },
  {
    name: "1000001+",
    min: 1000001,
    max: Infinity
  }
];


// ==================================================
// CACHE
// ==================================================

const cache = {
  latestGameweek: null,
  latestResult: null,
  previousResults: {},
  refreshing: false
};


// ==================================================
// JSON RESPONSE
// ==================================================

function sendJSON(res, status, data) {
  res.writeHead(status);
  res.end(JSON.stringify(data));
}


// ==================================================
// GET FPL BOOTSTRAP
// ==================================================

async function getFPLData() {
  const response = await fetch(FPL_URL);

  if (!response.ok) {
    throw new Error(
      `FPL API returned ${response.status}`
    );
  }

  return await response.json();
}


// ==================================================
// FIND LATEST COMPLETED GW
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
  const response =
    await fetch(
      `${STANDINGS_URL}?page_standings=${page}`
    );

  if (!response.ok) {
    throw new Error(
      `Standings returned ${response.status}`
    );
  }

  return await response.json();
}


// ==================================================
// GET MANAGERS FOR TIER
// ==================================================

async function getManagersForTier(tier) {
  const eligible = [];

  let page = 1;

  while (eligible.length < SAMPLE_SIZE) {

    const data =
      await getStandingsPage(page);

    const managers =
      data.standings.results;

    if (managers.length === 0) {
      break;
    }

    for (const manager of managers) {

      if (
        manager.rank >= tier.min &&
        manager.rank <= tier.max
      ) {
        eligible.push(manager);
      }

      if (
        eligible.length >= SAMPLE_SIZE
      ) {
        break;
      }
    }

    if (managers.length < 50) {
      break;
    }

    page++;
  }

  return eligible.slice(
    0,
    SAMPLE_SIZE
  );
}


// ==================================================
// GET MANAGER PICKS
// ==================================================

async function getManagerPicks(
  managerId,
  gameweek
) {
  const response =
    await fetch(
      `https://fantasy.premierleague.com/api/entry/${managerId}/event/${gameweek}/picks/`
    );

  if (!response.ok) {
    throw new Error(
      `Picks returned ${response.status}`
    );
  }

  return await response.json();
}


// ==================================================
// ANALYZE ONE TIER
// ==================================================

async function analyzeTier(
  tier,
  gameweek
) {
  console.log(
    `Starting tier ${tier.name}`
  );

  const managers =
    await getManagersForTier(tier);

  const results = [];

  const ownership = {};
  const captaincy = {};
  const tripleCaptaincy = {};


  // --------------------------------------------------
  // Sequential on purpose for now.
  // We will optimize this after proving reliability.
  // --------------------------------------------------

  for (const manager of managers) {

    console.log(
      `Fetching rank ${manager.rank}, manager ${manager.entry}`
    );

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
      // TC
      // ----------------------------------------------

      if (tripleCaptain) {

        const playerId =
          String(
            tripleCaptain.element
          );

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

  const sampleSize =
    successfulManagers.length;


  // ==================================================
  // OWNERSHIP %
  // ==================================================

  const ownershipPercent = {};

  for (
    const [playerId, count]
    of Object.entries(ownership)
  ) {

    ownershipPercent[playerId] =
      Number(
        (
          count /
          sampleSize *
          100
        ).toFixed(1)
      );
  }


  // ==================================================
  // CAPTAINCY %
  // ==================================================

  const captaincyPercent = {};

  for (
    const [playerId, count]
    of Object.entries(captaincy)
  ) {

    captaincyPercent[playerId] =
      Number(
        (
          count /
          sampleSize *
          100
        ).toFixed(1)
      );
  }


  // ==================================================
  // TC %
  // ==================================================

  const tripleCaptainPercent = {};

  for (
    const [playerId, count]
    of Object.entries(
      tripleCaptaincy
    )
  ) {

    tripleCaptainPercent[playerId] =
      Number(
        (
          count /
          sampleSize *
          100
        ).toFixed(1)
      );
  }


  return {

    tier:
      tier.name,

    rankRange: {
      min:
        tier.min,

      max:
        tier.max === Infinity
          ? null
          : tier.max
    },

    requestedSampleSize:
      SAMPLE_SIZE,

    successfulSampleSize:
      sampleSize,

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
// BUILD COMPLETE GW RESULT
// ==================================================

async function buildGameweekResult(gameweek) {

  console.log(
    `========================================`
  );

  console.log(
    `BUILDING CACHE FOR GW ${gameweek}`
  );

  console.log(
    `========================================`
  );


  const tiers = [];

  for (const tier of TIERS) {

    const result =
      await analyzeTier(
        tier,
        gameweek
      );

    tiers.push(result);
  }


  return {

    season:
      "2026/27",

    gameweek,

    sampleSize:
      SAMPLE_SIZE,

    createdAt:
      new Date().toISOString(),

    tiers
  };
}


// ==================================================
// REFRESH CACHE
// ==================================================

async function refreshCache() {

  // Prevent two refreshes happening at once.
  if (cache.refreshing) {
    console.log(
      "Cache refresh already running."
    );

    return;
  }

  cache.refreshing = true;


  try {

    const fplData =
      await getFPLData();

    const latestGameweek =
      getLatestCompletedGameweek(
        fplData
      );


    if (!latestGameweek) {

      console.log(
        "No completed gameweek yet."
      );

      return;
    }


    // ----------------------------------------------
    // Already have this GW
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
    // New GW detected
    // ----------------------------------------------

    console.log(
      `NEW COMPLETED GW DETECTED: ${latestGameweek}`
    );


    const result =
      await buildGameweekResult(
        latestGameweek
      );


    // Keep old result available.
    if (
      cache.latestGameweek !== null &&
      cache.latestResult !== null
    ) {

      cache.previousResults[
        cache.latestGameweek
      ] =
        cache.latestResult;
    }


    // Store new result.
    cache.latestGameweek =
      latestGameweek;

    cache.latestResult =
      result;


    console.log(
      `GW ${latestGameweek} CACHE READY`
    );


  } catch (error) {

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
// START AUTOMATIC REFRESH LOOP
// ==================================================

refreshCache();

setInterval(
  refreshCache,
  REFRESH_INTERVAL
);


// ==================================================
// SERVER
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
            status: "ok",

            latestCompletedGameweek:
              cache.latestGameweek,

            cacheReady:
              cache.latestResult !== null
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


        sendJSON(
          res,
          200,
          cache.latestResult
        );

        return;
      }


      // ==================================================
      // TEST SPECIFIC GW
      //
      // Example:
      //
      // /api/sample-tiers?gw=1
      //
      // This does NOT replace the automatic cache.
      // It is only for testing.
      // ==================================================

      if (
        req.method === "GET" &&
        req.url.startsWith(
          "/api/sample-tiers?gw="
        )
      ) {

        const url =
          new URL(
            req.url,
            "http://localhost"
          );

        const requestedGW =
          Number(
            url.searchParams.get(
              "gw"
            )
          );


        if (
          !Number.isInteger(
            requestedGW
          ) ||
          requestedGW < 1 ||
          requestedGW > 38
        ) {

          sendJSON(
            res,
            400,
            {
              error:
                "GW must be an integer from 1 to 38"
            }
          );

          return;
        }


        try {

          // If this GW is already cached,
          // simply return it.

          if (
            cache.previousResults[
              requestedGW
            ]
          ) {

            sendJSON(
              res,
              200,
              cache.previousResults[
                requestedGW
              ]
            );

            return;
          }


          if (
            cache.latestGameweek ===
            requestedGW
          ) {

            sendJSON(
              res,
              200,
              cache.latestResult
            );

            return;
          }


          // Otherwise build it.
          console.log(
            `Manual test requested for GW ${requestedGW}`
          );


          const result =
            await buildGameweekResult(
              requestedGW
            );


          // Store it.
          cache.previousResults[
            requestedGW
          ] =
            result;


          sendJSON(
            res,
            200,
            result
          );

        } catch (error) {

          sendJSON(
            res,
            500,
            {
              error:
                "Could not build requested GW",

              details:
                error.message
            }
          );
        }

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

            storedHistoricalGameweeks:
              Object.keys(
                cache.previousResults
              ).map(
                Number
              )

          }
        );

        return;
      }


      // ==================================================
      // RAW FPL DATA
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
