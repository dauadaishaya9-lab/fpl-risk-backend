import http from "node:http";

const PORT = process.env.PORT || 3000;
const FPL_URL =
  "https://fantasy.premierleague.com/api/bootstrap-static/";

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
console.log("REQUEST URL:", JSON.stringify(req.url));
  if (req.url === "/api/fpl") {
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

  if (req.url === "/api/sample") {
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

  if (req.url === "/api/previous-gw") {
    try {
      const response = await fetch(FPL_URL);

      if (!response.ok) {
        throw new Error(`FPL API returned ${response.status}`);
      }

      const data = await response.json();

      const completedEvents = data.events.filter(function (event) {
        return event.finished === true;
      });

      const previousGameweek =
        completedEvents[completedEvents.length - 1].id;

      res.writeHead(200);
      res.end(JSON.stringify({
        previousGameweek: previousGameweek
      }));
    } catch (error) {
      res.writeHead(502);
      res.end(JSON.stringify({
        error: "Could not determine previous gameweek"
      }));
    }

    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({
    error: "Not found"
  }));
});

server.listen(PORT, "0.0.0.0", function () {
  console.log(`Server running on port ${PORT}`);
});
