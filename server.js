import http from "node:http";

const PORT = process.env.PORT || 3000;

const FPL_URL =
  "https://fantasy.premierleague.com/api/bootstrap-static/";

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // --------------------------------
  // GET FPL DATA
  // --------------------------------
  if (req.method === "GET" && req.url === "/api/fpl") {
    try {
      const response = await fetch(FPL_URL);

      if (!response.ok) {
        throw new Error(`FPL API returned ${response.status}`);
      }

      const data = await response.json();

      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(502);
      res.end(JSON.stringify({
        error: "Could not fetch FPL data"
      }));
    }

    return;
  }

  // --------------------------------
  // SAMPLE 10 MANAGERS
  // --------------------------------
  if (req.method === "GET" && req.url === "/api/sample") {
    try {
      const response = await fetch(
        "https://fantasy.premierleague.com/api/leagues-classic/314/standings/"
      );

      if (!response.ok) {
        throw new Error(
          `FPL standings returned ${response.status}`
        );
      }

      const data = await response.json();

      res.writeHead(200);
      res.end(
        JSON.stringify(data.standings.results.slice(0, 10))
      );
    } catch (error) {
      res.writeHead(502);
      res.end(JSON.stringify({
        error: "Could not fetch standings"
      }));
    }

    return;
  }

  // --------------------------------
  // FIND PREVIOUS GAMEWEEK
  // --------------------------------
  if (req.method === "GET" && req.url === "/api/previous-gw") {
    try {
      const response = await fetch(FPL_URL);

      if (!response.ok) {
        throw new Error(`FPL API returned ${response.status}`);
      }

      const data = await response.json();

      const completedEvents = data.events.filter(
        (event) => event.finished === true
      );

      const previousGameweek =
        completedEvents[completedEvents.length - 1].id;

      res.writeHead(200);
      res.end(JSON.stringify({
        previousGameweek
      }));
    } catch (error) {
      res.writeHead(502);
      res.end(JSON.stringify({
        error: "Could not determine previous gameweek"
      }));
    }

    return;
  }

  // --------------------------------
  // TEMPORARY GW38 TEST
  // --------------------------------
  if (
    req.method === "GET" &&
    req.url.startsWith("/api/test-gw38")
  ) {
    try {
      const url = new URL(req.url, "http://localhost");

      const tier = Number(
        url.searchParams.get("tier") || 1
      );

      const tierSize = 10;

      const startRank =
        (tier - 1) * tierSize + 1;

      const endRank =
        tier * tierSize;

      if (!Number.isInteger(tier) || tier < 1) {
        res.writeHead(400);
        res.end(JSON.stringify({
          error: "Tier must be a positive integer"
        }));

        return;
      }

      const page = Math.ceil(startRank / 50);

      const standingsResponse = await fetch(
        `https://fantasy.premierleague.com/api/leagues-classic/314/standings/?page_standings=${page}`
      );

      if (!standingsResponse.ok) {
        throw new Error(
          `FPL standings returned ${standingsResponse.status}`
        );
      }

      const standingsData =
        await standingsResponse.json();

      const managers =
        standingsData.standings.results.filter(
          (manager) =>
            manager.rank >= startRank &&
            manager.rank <= endRank
        );

      const results = [];

      for (const manager of managers) {
        const picksResponse = await fetch(
          `https://fantasy.premierleague.com/api/entry/${manager.entry}/event/38/picks/`
        );

        if (!picksResponse.ok) {
          results.push({
            rank: manager.rank,
            managerId: manager.entry,
            error: `Picks returned ${picksResponse.status}`
          });

          continue;
        }

        const picksData =
          await picksResponse.json();

        results.push({
          rank: manager.rank,
          managerId: manager.entry,
          managerName: manager.player_name,
          teamName: manager.entry_name,
          overallPoints: manager.total,
          activeChip: picksData.active_chip,
          picks: picksData.picks
        });
      }

      res.writeHead(200);

      res.end(JSON.stringify({
        gameweek: 38,
        tier,
        rankRange: `${startRank}-${endRank}`,
        sampleSize: results.length,
        managers: results
      }));

    } catch (error) {
      res.writeHead(502);

      res.end(JSON.stringify({
        error: "Could not build GW38 sample"
      }));
    }

    return;
  }

  // --------------------------------
  // UNKNOWN ROUTE
  // --------------------------------
  res.writeHead(404);

  res.end(JSON.stringify({
    error: "Not found"
  }));
});

// --------------------------------
// START SERVER
// --------------------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
