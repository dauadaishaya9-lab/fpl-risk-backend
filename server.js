import http from "node:http";

const PORT = process.env.PORT || 3000;

const FPL_URL =
  "https://fantasy.premierleague.com/api/bootstrap-static/";

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

const SAMPLE_SIZE = 10;


// ==================================================
// HELPER: SEND JSON
// ==================================================

function sendJSON(res, status, data) {
  res.writeHead(status);
  res.end(JSON.stringify(data));
}


// ==================================================
// GET CURRENT FPL DATA
// ==================================================

async function getFPLData() {

  const response =
    await fetch(FPL_URL);

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

  const completed =
    data.events.filter(
      event => event.finished === true
    );

  if (completed.length === 0) {
    return null;
  }

  return completed[
    completed.length - 1
  ].id;
}


// ==================================================
// GET STANDINGS PAGE
// ==================================================

async function getStandingsPage(page) {

  const response =
    await fetch(
      `https://fantasy.premierleague.com/api/leagues-classic/314/standings/?page_standings=${page}`
    );

  if (!response.ok) {
    throw new Error(
      `Standings returned ${response.status}`
    );
  }

  return await response.json();
}


// ==================================================
// GET MANAGERS FOR A TIER
// ==================================================

async function getManagersForTier(tier) {

  /*
    FPL standings are paginated.

    Each page contains roughly 50 managers.

    We keep requesting pages until we've
    collected enough managers for the tier.
  */

  const managers = [];

  let page = 1;

  while (
    managers.length < SAMPLE_SIZE
  ) {

    const data =
      await getStandingsPage(page);

    const results =
      data.standings.results;

    if (!results.length) {
      break;
    }

    for (
      const manager of results
    ) {

      if (
        manager.rank >= tier.min &&
        manager.rank <= tier.max
      ) {

        managers.push(manager);

        if (
          managers.length === SAMPLE_SIZE
        ) {
          break;
        }
      }
    }

    if (
      results.length < 50
    ) {
      break;
    }

    page++;
  }

  return managers;
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
// ANALYZE TIER
// ==================================================

async function analyzeTier(
  tier,
  gameweek
) {

  const managers =
    await getManagersForTier(
      tier
    );

  const results = [];

  const ownership = {};
  const captaincy = {};
  const tripleCaptaincy = {};


  // ----------------------------------------------
  // FETCH EACH MANAGER
  // ----------------------------------------------

  for (
    const manager of managers
  ) {

    try {

      const picksData =
        await getManagerPicks(
          manager.entry,
          gameweek
        );

      const picks =
        picksData.picks || [];


      // ------------------------------------------
      // CAPTAIN
      // ------------------------------------------

      const captain =
        picks.find(
          pick =>
            pick.is_captain === true
        );


      // ------------------------------------------
      // TRIPLE CAPTAIN
      // ------------------------------------------

      const tripleCaptain =
        picks.find(
          pick =>
            pick.is_captain === true &&
            pick.multiplier === 3
        );


      // ------------------------------------------
      // OWNERSHIP
      // ------------------------------------------

      for (
        const pick of picks
      ) {

        const playerId =
          String(pick.element);

        ownership[playerId] =
          (ownership[playerId] || 0) + 1;
      }


      // ------------------------------------------
      // CAPTAINCY
      // ------------------------------------------

      if (captain) {

        const playerId =
          String(captain.element);

        captaincy[playerId] =
          (captaincy[playerId] || 0) + 1;
      }


      // ------------------------------------------
      // TC
      // ------------------------------------------

      if (tripleCaptain) {

        const playerId =
          String(
            tripleCaptain.element
          );

        tripleCaptaincy[playerId] =
          (tripleCaptaincy[playerId] || 0) + 1;
      }


      // ------------------------------------------
      // SAVE MANAGER
      // ------------------------------------------

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
  // CONVERT COUNTS TO PERCENTAGES
  // ==================================================

  const sampleSize =
    results.filter(
      manager =>
        manager.picks
    ).length;


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


      // --------------------------------------------
      // HEALTH CHECK
      // --------------------------------------------

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
              "FPL rank-tier backend is running"
          }
        );

        return;
      }


      // --------------------------------------------
      // RAW FPL DATA
      // --------------------------------------------

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
                "Could not fetch FPL data"
            }
          );
        }

        return;
      }


      // --------------------------------------------
      // LATEST COMPLETED GW
      // --------------------------------------------

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


      // --------------------------------------------
      // RANK-TIER SAMPLE
      // --------------------------------------------

      if (
        req.method === "GET" &&
        req.url === "/api/sample-tiers"
      ) {

        try {

          const fplData =
            await getFPLData();

          const gameweek =
            getLatestCompletedGameweek(
              fplData
            );


          if (!gameweek) {

            sendJSON(
              res,
              400,
              {
                error:
                  "There is no completed gameweek yet"
              }
            );

            return;
          }


          const tiers = [];

          for (
            const tier of TIERS
          ) {

            console.log(
              `Sampling tier ${tier.name}`
            );

            const result =
              await analyzeTier(
                tier,
                gameweek
              );

            tiers.push(result);
          }


          sendJSON(
            res,
            200,
            {
              season:
                "2026/27",

              gameweek,

              sampleSize:
                SAMPLE_SIZE,

              tiers
            }
          );

        } catch (error) {

          console.error(error);

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


      // --------------------------------------------
      // UNKNOWN ROUTE
      // --------------------------------------------

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
