import http from "node:http";

const PORT = process.env.PORT || 3000;

const FPL_URL =
  "https://fantasy.premierleague.com/api/bootstrap-static/";

const STANDINGS_URL =
  "https://fantasy.premierleague.com/api/leagues-classic/314/standings/";

const SAMPLE_SIZE = 10;

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
// SEND JSON
// ==================================================

function sendJSON(res, status, data) {
  res.writeHead(status);
  res.end(JSON.stringify(data));
}


// ==================================================
// GET FPL BOOTSTRAP DATA
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
// GET 10 MANAGERS FOR A TIER
// ==================================================

async function getManagersForTier(tier) {

  const eligible = [];

  let page = 1;

  /*
    We fetch standings pages until we have
    enough managers for the requested tier.

    We keep this sequential for now because
    we're testing the machinery first.
  */

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

    /*
      If the page contains fewer than 50
      managers, there are no more pages.
    */

    if (managers.length < 50) {
      break;
    }

    page++;
  }

  /*
    IMPORTANT:

    At this stage we're taking the first
    10 managers found in the tier.

    We will improve the sampling method
    after we prove the API machinery works.
  */

  return eligible.slice(
    0,
    SAMPLE_SIZE
  );
}


// ==================================================
// GET MANAGER GW PICKS
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

  const managers =
    await getManagersForTier(tier);

  const results = [];

  const ownership = {};

  const captaincy = {};

  const tripleCaptaincy = {};


  // ==================================================
  // FETCH MANAGERS
  // ==================================================

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
      // PLAYER OWNERSHIP
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
          String(
            tripleCaptain.element
          );

        tripleCaptaincy[playerId] =
          (tripleCaptaincy[playerId] || 0) + 1;
      }


      // ----------------------------------------------
      // SAVE MANAGER
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
        `Failed manager ${manager.entry}:`,
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
  // SUCCESSFUL SAMPLE SIZE
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

  if (sampleSize > 0) {

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
  }


  // ==================================================
  // CAPTAINCY %
  // ==================================================

  const captaincyPercent = {};

  if (sampleSize > 0) {

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
  }


  // ==================================================
  // TC %
  // ==================================================

  const tripleCaptainPercent = {};

  if (sampleSize > 0) {

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

            message:
              "FPL rank-tier backend is running",

            season:
              "2026/27"
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
      // LATEST COMPLETED GAMEWEEK
      // ==================================================

      if (
        req.method === "GET" &&
        req.url === "/api/previous-gw"
      ) {

        try {

          const data =
            await getFPLData();

          const gameweek =
            getLatestCompletedGameweek(
              data
            );

          if (!gameweek) {

            sendJSON(
              res,
              404,
              {
                error:
                  "No completed gameweek yet"
              }
            );

            return;
          }

          sendJSON(
            res,
            200,
            {
              previousGameweek:
                gameweek
            }
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
      // SAMPLE RANK TIERS
      //
      // /api/sample-tiers
      //
      // Automatically uses latest completed GW.
      //
      // /api/sample-tiers?gw=1
      //
      // Forces a specific GW for testing.
      // ==================================================

      if (
        req.method === "GET" &&
        req.url.startsWith(
          "/api/sample-tiers"
        )
      ) {

        try {

          const url =
            new URL(
              req.url,
              "http://localhost"
            );


          // --------------------------------------------
          // GET FORCED GW
          // --------------------------------------------

          const gwParameter =
            url.searchParams.get(
              "gw"
            );


          let gameweek;


          // --------------------------------------------
          // USE FORCED GW
          // --------------------------------------------

          if (gwParameter !== null) {

            gameweek =
              Number(gwParameter);

            if (
              !Number.isInteger(gameweek) ||
              gameweek < 1 ||
              gameweek > 38
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

          }

          // --------------------------------------------
          // OTHERWISE FIND COMPLETED GW
          // --------------------------------------------

          else {

            const fplData =
              await getFPLData();

            gameweek =
              getLatestCompletedGameweek(
                fplData
              );


            if (!gameweek) {

              sendJSON(
                res,
                400,
                {
                  error:
                    "There is no completed gameweek yet. Use ?gw=1 to test a specific gameweek."
                }
              );

              return;
            }
          }


          // --------------------------------------------
          // ANALYZE ALL TIERS
          // --------------------------------------------

          const tiers = [];


          for (
            const tier of TIERS
          ) {

            console.log(
              `Starting tier ${tier.name}`
            );

            const result =
              await analyzeTier(
                tier,
                gameweek
              );

            tiers.push(result);
          }


          // --------------------------------------------
          // RESPONSE
          // --------------------------------------------

          sendJSON(
            res,
            200,
            {

              test:
                gwParameter !== null,

              season:
                "2026/27",

              gameweek,

              sampleSize:
                SAMPLE_SIZE,

              tiers
            }
          );

        } catch (error) {

          console.error(
            error
          );

          sendJSON(
            res,
            500,
            {
              error:
                "Could not build rank-tier sample",

              details:
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
