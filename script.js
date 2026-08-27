let selectedPlayer = null;
let ownsPlayer = null;
let captainsPlayer = null;
let tripleCaptainsPlayer = null;

let players = [];
let sampleData = null;

// ==================================================
// BACKEND URL
// ==================================================

const BACKEND_URL = "https://fpl-risk-backend.onrender.com";

// ==================================================
// GET HTML ELEMENTS
// ==================================================

const fplid = document.getElementById("fpl-id");
const riskResult = document.getElementById("risk-result");
const register = document.getElementById("register");
const checkRisk = document.getElementById("check-risk");
const points = document.getElementById("points");
const playerSearch = document.getElementById("player-search");
const playerOptions = document.getElementById("player-options");
const ownYes = document.getElementById("own-yes");
const ownNo = document.getElementById("own-no");
const capYes = document.getElementById("cap-yes");
const capNo = document.getElementById("cap-no");
const tcYes = document.getElementById("tc-yes");
const tcNo = document.getElementById("tc-no");

function showResult(message) {
    console.log(message);
    if (riskResult) riskResult.textContent = message;
}

// ==================================================
// RANK TIER
// ==================================================

function getRankTier(globalRank) {
    if (!Number.isFinite(globalRank) || globalRank <= 0) return null;
    if (globalRank <= 10000) return "1-10000";
    if (globalRank <= 50000) return "10001-50000";
    if (globalRank <= 100000) return "50001-100000";
    if (globalRank <= 250000) return "100001-250000";
    if (globalRank <= 500000) return "250001-500000";
    if (globalRank <= 1000000) return "500001-1000000";
    if (globalRank <= 2000000) return "1000001-2000000";
    if (globalRank <= 3000000) return "2000001-3000000";
    if (globalRank <= 4000000) return "3000001-4000000";
    if (globalRank <= 5000000) return "4000001-5000000";
    return "5000001+";
}

// ==================================================
// LOAD PLAYERS
// ==================================================

async function loadPlayers() {
    try {
        const response = await fetch(BACKEND_URL + "/api/fpl");
        if (!response.ok) {
            throw new Error("Could not load FPL player data. HTTP " + response.status);
        }

        const data = await response.json();
        players = Array.isArray(data.elements) ? data.elements : [];
        console.log("Players loaded:", players.length);
    } catch (error) {
        console.error("Failed to load players:", error);
        showResult("Failed to load players: " + error.message);
    }
}

// ==================================================
// LOAD SAMPLE DATA
// ==================================================

async function loadSampleData() {
    try {
        console.log("Loading risk data...");

        const response = await fetch(BACKEND_URL + "/api/sample-tiers");
        console.log("Sample data HTTP status:", response.status);

        if (!response.ok) {
            const errorText = await response.text();
            console.error("Sample data backend response:", errorText);

            if (response.status === 503) {
                showResult("Risk data is not ready yet. The locked sample will appear after the next completed gameweek sample.");
                return;
            }

            throw new Error("Risk data request failed. HTTP " + response.status);
        }

        sampleData = await response.json();
        console.log("========== SAMPLE DATA LOADED ==========");
        console.log("Sample data:", sampleData);
        console.log("Bands:", sampleData?.bands);
    } catch (error) {
        console.error("========== SAMPLE DATA ERROR ==========");
        console.error(error);
        showResult("Failed to load risk data: " + error.message);
    }
}

// ==================================================
// REGISTER FPL ID
// ==================================================

if (register) {
    register.addEventListener("click", async function () {
        const fplId = fplid ? fplid.value.trim() : "";

        if (!fplId || !/^\d+$/.test(fplId)) {
            showResult("Please enter a valid FPL ID.");
            return;
        }

        try {
            showResult("Getting your FPL information...");

            const response = await fetch(BACKEND_URL + "/api/entry/" + fplId);
            if (!response.ok) throw new Error("FPL ID not found.");

            const data = await response.json();
            const globalRank = Number(data.overallRank);
            const rankTier = getRankTier(globalRank);

            if (!rankTier) throw new Error("Global rank is not available yet.");

            localStorage.setItem("fplId", fplId);

            console.log("========== FPL REGISTERED ==========");
            console.log("FPL ID:", fplId);
            console.log("Global Rank:", globalRank);
            console.log("Rank Tier:", rankTier);

            showResult("Registered! Rank " + globalRank + " • Tier " + rankTier);
        } catch (error) {
            console.error("Registration failed:", error);
            showResult("Registration failed: " + error.message);
        }
    });
}

// ==================================================
// RESTORE SAVED FPL ID
// ==================================================

const savedFplId = localStorage.getItem("fplId");
if (savedFplId && fplid) fplid.value = savedFplId;
if (savedFplId) console.log("Saved FPL ID:", savedFplId);

// ==================================================
// OWNERSHIP
// ==================================================

if (ownYes) {
    ownYes.addEventListener("click", function () {
        ownsPlayer = true;
        console.log("Own player:", ownsPlayer);
    });
}

if (ownNo) {
    ownNo.addEventListener("click", function () {
        ownsPlayer = false;
        captainsPlayer = false;
        tripleCaptainsPlayer = false;
        console.log("Own player:", ownsPlayer);
        console.log("Captain player:", captainsPlayer);
    });
}

// ==================================================
// CAPTAINCY
// ==================================================

if (capYes) {
    capYes.addEventListener("click", function () {
        if (ownsPlayer !== true) {
            showResult("You must own the player before captaining them.");
            return;
        }
        captainsPlayer = true;
        console.log("Captain player:", captainsPlayer);
    });
}

if (capNo) {
    capNo.addEventListener("click", function () {
        captainsPlayer = false;
        tripleCaptainsPlayer = false;
        console.log("Captain player:", captainsPlayer);
    });
}

// ==================================================
// TRIPLE CAPTAINCY
// ==================================================

if (tcYes) {
    tcYes.addEventListener("click", function () {
        if (ownsPlayer !== true) {
            showResult("You must own the player before Triple Captaining them.");
            return;
        }
        if (captainsPlayer !== true) {
            showResult("You must captain the player before Triple Captaining them.");
            return;
        }
        tripleCaptainsPlayer = true;
        console.log("Triple Captain player:", tripleCaptainsPlayer);
    });
}

if (tcNo) {
    tcNo.addEventListener("click", function () {
        tripleCaptainsPlayer = false;
        console.log("Triple Captain player:", tripleCaptainsPlayer);
    });
}

// ==================================================
// PLAYER SEARCH
// ==================================================

if (playerSearch && playerOptions) {
    playerSearch.addEventListener("input", function () {
        playerOptions.innerHTML = "";

        const searchText = playerSearch.value.toLowerCase().trim();
        if (!searchText) return;

        players.forEach(function (playerData) {
            const fullName =
                String(playerData.first_name || "") +
                " " +
                String(playerData.second_name || "");

            if (!fullName.toLowerCase().includes(searchText)) return;

            const playerOption = document.createElement("button");
            playerOption.type = "button";
            playerOption.textContent = fullName;

            playerOption.addEventListener("click", function () {
                selectedPlayer = playerData;

                ownsPlayer = null;
                captainsPlayer = null;
                tripleCaptainsPlayer = null;

                console.log("========== PLAYER SELECTED ==========");
                console.log("Player:", fullName);
                console.log("ID:", playerData.id);
                console.log("EO:", playerData.selected_by_percent + "%");

                playerSearch.value = fullName;
                playerOptions.innerHTML = "";
            });

            playerOptions.appendChild(playerOption);
        });
    });
}

// ==================================================
// CHECK RISK
// ==================================================

if (checkRisk) {
    checkRisk.addEventListener("click", async function () {
        const userFplId = localStorage.getItem("fplId");

        if (!userFplId) {
            showResult("Please register your FPL ID first.");
            return;
        }

        if (!selectedPlayer) {
            showResult("Please select a player.");
            return;
        }

        if (ownsPlayer === null) {
            showResult("Please select YES or NO for ownership.");
            return;
        }

        if (captainsPlayer === null) {
            showResult("Please select YES or NO for captaincy.");
            return;
        }

        if (tripleCaptainsPlayer === null) {
            showResult("Please select YES or NO for Triple Captaincy.");
            return;
        }

        const playerPoints = Number(points ? points.value : NaN);
        if (!Number.isFinite(playerPoints) || playerPoints < 0) {
            showResult("Please enter valid expected points.");
            return;
        }

        if (!sampleData || !Array.isArray(sampleData.bands)) {
            showResult("Risk data is not ready yet.");
            return;
        }

        try {
            console.log("Getting your current FPL rank...");

            const response = await fetch(BACKEND_URL + "/api/entry/" + userFplId);
            if (!response.ok) throw new Error("Could not fetch your current FPL rank.");

            const data = await response.json();
            const globalRank = Number(data.overallRank);
            if (!Number.isFinite(globalRank) || globalRank <= 0) {
                throw new Error("Current global rank is not available.");
            }

            const rankTier = getRankTier(globalRank);
            if (!rankTier) throw new Error("Could not determine your current rank tier.");

            const tierData = sampleData.bands.find(function (tier) {
                return tier.band === rankTier;
            });

            if (!tierData || !Array.isArray(tierData.managers) || tierData.managers.length === 0) {
                throw new Error("Your current rank tier is not available in the completed sample.");
            }

            const playerId = String(selectedPlayer.id);

            let yourMultiplier = 0;
            if (ownsPlayer === true) {
                yourMultiplier = 1;
                if (captainsPlayer === true) {
                    yourMultiplier = 2;
                    if (tripleCaptainsPlayer === true) yourMultiplier = 3;
                }
            }

            const yourPoints = playerPoints * yourMultiplier;

            let managersWithPlayer = 0;
            let managersWithoutPlayer = 0;
            let managersCaptainingPlayer = 0;
            let totalPointDifference = 0;
            let comparisons = 0;
            let totalEffectiveOwnership = 0;

            tierData.managers.forEach(function (manager) {
                if (!Array.isArray(manager.picks)) return;

                const playerPick = manager.picks.find(function (pick) {
                    return String(pick.element) === playerId;
                });

                if (playerPick) {
                    managersWithPlayer++;

                    if (playerPick.is_captain === true) {
                        managersCaptainingPlayer++;
                    }

                    totalEffectiveOwnership += Number(playerPick.multiplier) || 1;
                } else {
                    managersWithoutPlayer++;
                }

                const managerMultiplier = playerPick
                    ? Number(playerPick.multiplier) || 1
                    : 0;

                const managerPoints = playerPoints * managerMultiplier;
                totalPointDifference += yourPoints - managerPoints;
                comparisons++;
            });

            const averagePointSwing = comparisons > 0
                ? Number((totalPointDifference / comparisons).toFixed(1))
                : 0;

            const playerEO = comparisons > 0
                ? Number((totalEffectiveOwnership / comparisons * 100).toFixed(1))
                : 0;

            const sampleOwnershipPercent = comparisons > 0
                ? Number((managersWithPlayer / comparisons * 100).toFixed(1))
                : 0;

            const sampleCaptainPercent = comparisons > 0
                ? Number((managersCaptainingPlayer / comparisons * 100).toFixed(1))
                : 0;

            let resultMessage;
            if (averagePointSwing > 0) {
                resultMessage = "You gain points against the sampled managers.";
            } else if (averagePointSwing < 0) {
                resultMessage = "You lose points against the sampled managers.";
            } else {
                resultMessage = "There is no points swing against the sampled managers.";
            }

            console.log("========== FPL RISK ==========");
            console.log("Player:", selectedPlayer.first_name, selectedPlayer.second_name);
            console.log("Player EO:", playerEO + "%");
            console.log("FPL ID:", userFplId);
            console.log("Global Rank:", globalRank);
            console.log("Rank Tier:", rankTier);
            console.log("Managers sampled:", comparisons);
            console.log("Managers owning:", managersWithPlayer);
            console.log("Managers without player:", managersWithoutPlayer);
            console.log("Managers captaining:", managersCaptainingPlayer);
            console.log("Sample ownership:", sampleOwnershipPercent + "%");
            console.log("Sample captaincy:", sampleCaptainPercent + "%");
            console.log("Differential:", averagePointSwing + " points");
            console.log("Own player:", ownsPlayer);
            console.log("Captain player:", captainsPlayer);
            console.log("Triple Captain player:", tripleCaptainsPlayer);
            console.log("Expected points:", playerPoints);
            console.log("Your expected points with multiplier:", yourPoints);
            console.log("Result:", resultMessage);

            // Use DOM nodes instead of injecting API values with innerHTML.
            if (riskResult) {
                riskResult.innerHTML = "";

                const title = document.createElement("h2");
                title.textContent = "Risk Result";
                riskResult.appendChild(title);

                const values = [
                    ["Player", selectedPlayer.first_name + " " + selectedPlayer.second_name],
                    ["Your rank", globalRank],
                    ["Rank tier", rankTier],
                    ["Player EO", playerEO + "%"],
                    ["Sample ownership", sampleOwnershipPercent + "%"],
                    ["Differential", averagePointSwing + " points"],
                    ["Sample captaincy", sampleCaptainPercent + "%"],
                    ["Expected points", playerPoints],
                    ["Your points", yourPoints]
                ];

                values.forEach(function (item) {
                    const p = document.createElement("p");
                    p.textContent = item[0] + ": ";
                    const strong = document.createElement("strong");
                    strong.textContent = String(item[1]);
                    p.appendChild(strong);
                    riskResult.appendChild(p);
                });

                const result = document.createElement("p");
                result.textContent = resultMessage;
                riskResult.appendChild(result);
            }
        } catch (error) {
            console.error("Risk check failed:", error);
            showResult("Risk check failed: " + error.message);
        }
    });
}

// Start both independent loads after all DOM references exist.
loadPlayers();
loadSampleData();
