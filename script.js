let selectedPlayer = null
let ownsPlayer = null
let captainsPlayer = null
let tripleCaptainsPlayer = null

let players = []
let sampleData = null

// ==================================================
// BACKEND URL
// ==================================================

const BACKEND_URL =
    "https://fpl-risk-backend.onrender.com"


// ==================================================
// LOAD PLAYERS
// ==================================================

async function loadPlayers() {

    try {

        const response =
            await fetch(
                BACKEND_URL +
                "/api/fpl"
            )

        if (!response.ok) {
            throw new Error(
                "Could not load FPL player data."
            )
        }

        const data =
            await response.json()

        players =
            data.elements || []

        console.log(
            "Players loaded:",
            players.length
        )

    } catch (error) {

        console.error(
            "Failed to load players:",
            error
        )
    }
}


// ==================================================
async function loadSampleData() {

    try {

        console.log(
            "Loading risk data..."
        )

        const response =
            await fetch(
                BACKEND_URL +
                "/api/sample-tiers"
            )

        console.log(
            "Sample data HTTP status:",
            response.status
        )

        if (!response.ok) {

            const errorText =
                await response.text()

            console.error(
                "Sample data backend response:",
                errorText
            )

            throw new Error(
                "Risk data request failed. HTTP " +
                response.status
            )
        }

        sampleData =
            await response.json()

        console.log(
            "========== SAMPLE DATA LOADED =========="
        )

        console.log(
            "Sample data:",
            sampleData
        )

        console.log(
            "Bands:",
            sampleData?.bands
        )

    } catch (error) {

        console.error(
            "========== SAMPLE DATA ERROR =========="
        )

        console.error(
            error
        )

        if (riskResult) {

            riskResult.textContent =
                "Failed to load risk data: " +
                error.message
        }
    }
}

loadPlayers()
loadSampleData()
// ==================================================
// GET HTML ELEMENTS
// ==================================================

const fplid =
    document.getElementById("fpl-id")

const riskResult =
    document.getElementById("risk-result")

const register =
    document.getElementById("register")

const checkRisk =
    document.getElementById("check-risk")

const points =
    document.getElementById("points")

const playerSearch =
    document.getElementById("player-search")

const playerOptions =
    document.getElementById("player-options")

const ownYes =
    document.getElementById("own-yes")

const ownNo =
    document.getElementById("own-no")

const capYes =
    document.getElementById("cap-yes")

const capNo =
    document.getElementById("cap-no")
    const tcYes =
    document.getElementById("tc-yes")

const tcNo =
    document.getElementById("tc-no")


// ==================================================
// RANK TIER HELPER
// ==================================================
function getRankTier(globalRank) {

    if (!Number.isFinite(globalRank)) {
        return null
    }

    if (globalRank <= 10000) {
        return "1-10000"
    }

    if (globalRank <= 50000) {
        return "10001-50000"
    }

    if (globalRank <= 100000) {
        return "50001-100000"
    }

    if (globalRank <= 250000) {
        return "100001-250000"
    }

    if (globalRank <= 500000) {
        return "250001-500000"
    }

    if (globalRank <= 1000000) {
        return "500001-1000000"
    }

    if (globalRank <= 2000000) {
        return "1000001-2000000"
    }

    if (globalRank <= 3000000) {
        return "2000001-3000000"
    }

    if (globalRank <= 4000000) {
        return "3000001-4000000"
    }

    if (globalRank <= 5000000) {
        return "4000001-5000000"
    }

    return "5000001+"
}// ==================================================
// DISPLAY RESULT
// ==================================================

function showResult(message) {

    console.log(message)

    if (riskResult) {
        riskResult.textContent = message
    }
}


// ==================================================
// REGISTER FPL ID
// ==================================================

if (register) {

    register.addEventListener(
        "click",
        async function () {

            const fplId =
                fplid.value.trim()


            // ------------------------------------------
            // VALIDATE FPL ID
            // ------------------------------------------

            if (
                !fplId ||
                !/^\d+$/.test(fplId)
            ) {

                showResult(
                    "Please enter a valid FPL ID."
                )

                return
            }


            try {

                showResult(
                    "Getting your FPL information..."
                )


                // --------------------------------------
                // GET USER ENTRY
                // --------------------------------------

                const response =
                    await fetch(
                        BACKEND_URL +
                        "/api/entry/" +
                        fplId
                    )


                if (!response.ok) {

                    throw new Error(
                        "FPL ID not found."
                    )
                }


                const data =
                    await response.json()


                // --------------------------------------
                // GET GLOBAL RANK
                // --------------------------------------

                const globalRank =
                    Number(
                        data.overallRank
                    )


                if (
                    !Number.isFinite(globalRank) ||
                    globalRank <= 0
                ) {

                    throw new Error(
                        "Global rank is not available yet."
                    )
                }


                // --------------------------------------
                // FIND RANK TIER
                // --------------------------------------

                const rankTier =
                    getRankTier(
                        globalRank
                    )


                if (!rankTier) {

                    throw new Error(
                        "Could not determine your rank tier."
                    )
                }


                // --------------------------------------
                // SAVE USER DATA
                // --------------------------------------

                localStorage.setItem(
                    "fplId",
                    fplId
                )

                


                // --------------------------------------
                // SUCCESS
                // --------------------------------------

                console.log(
                    "========== FPL REGISTERED =========="
                )

                console.log(
                    "FPL ID:",
                    fplId
                )

                console.log(
                    "Global Rank:",
                    globalRank
                )

                console.log(
                    "Rank Tier:",
                    rankTier
                )


                showResult(
                    "Registered! Rank " +
                    globalRank +
                    " • Tier " +
                    rankTier
                )

            } catch (error) {

                console.error(
                    "Registration failed:",
                    error
                )

                showResult(
                    "Registration failed: " +
                    error.message
                )
            }
        }
    )
          }
  
// ==================================================
// RESTORE SAVED FPL DATA
// ==================================================

const savedFplId =
    localStorage.getItem("fplId")



if (
    savedFplId &&
    fplid
) {

    fplid.value =
        savedFplId
}


if (savedFplId) {

    console.log(
        "Saved FPL ID:",
        savedFplId
    )
}







// ==================================================
// OWNERSHIP DECISION
// ==================================================

if (ownYes) {

    ownYes.addEventListener(
        "click",
        function () {

            ownsPlayer = true

            console.log(
                "Own player:",
                ownsPlayer
            )
        }
    )
}


if (ownNo) {

    ownNo.addEventListener(
        "click",
        function () {

            ownsPlayer = false

            // Cannot captain a player
            // you don't own.

            captainsPlayer = false


            console.log(
                "Own player:",
                ownsPlayer
            )

            console.log(
                "Captain player:",
                captainsPlayer
            )
        }
    )
}


// ==================================================
// CAPTAINCY DECISION
// ==================================================

if (capYes) {

    capYes.addEventListener(
        "click",
        function () {

            if (ownsPlayer !== true) {

                showResult(
                    "You must own the player before captaining them."
                )

                return
            }


            captainsPlayer = true


            console.log(
                "Captain player:",
                captainsPlayer
            )
        }
    )
}


if (capNo) {

    capNo.addEventListener(
        "click",
        function () {

            captainsPlayer = false


            console.log(
                "Captain player:",
                captainsPlayer
            )
        }
    )
}
// ==================================================
// TRIPLE CAPTAINCY DECISION
// ==================================================

if (tcYes) {

    tcYes.addEventListener(
        "click",
        function () {

            if (ownsPlayer !== true) {

                showResult(
                    "You must own the player before Triple Captaining them."
                )

                return
            }

            if (captainsPlayer !== true) {

                showResult(
                    "You must captain the player before Triple Captaining them."
                )

                return
            }

            tripleCaptainsPlayer = true

            console.log(
                "Triple Captain player:",
                tripleCaptainsPlayer
            )
        }
    )
}


if (tcNo) {

    tcNo.addEventListener(
        "click",
        function () {

            tripleCaptainsPlayer = false

            console.log(
                "Triple Captain player:",
                tripleCaptainsPlayer
            )
        }
      // PLAYER SEARCH
// ==================================================

if (
    playerSearch &&
    playerOptions
) {

    playerSearch.addEventListener(
        "input",
        function () {

            playerOptions.innerHTML = ""


            const searchText =
                playerSearch.value
                    .toLowerCase()
                    .trim()


            // Don't show every player
            // when search is empty.

            if (!searchText) {
                return
            }


            players.forEach(
                function (playerData) {

                    const fullName =
                        playerData.first_name +
                        " " +
                        playerData.second_name


                    if (
                        !fullName
                            .toLowerCase()
                            .includes(
                                searchText
                            )
                    ) {

                        return
                    }


                    const playerOption =
                        document.createElement(
                            "button"
                        )


                    playerOption.type =
                        "button"


                    playerOption.textContent =
                        fullName


                    playerOption.value =
                        playerData.id


                    playerOption.addEventListener(
                        "click",
                        function () {

                            selectedPlayer =
                                playerData


                            // Reset decisions
                            // for new player.

                            ownsPlayer =
                                null 
                              tripleCaptainsPlayer =
    null  
                                
                            captainsPlayer =
                                null


                            console.log(
                                "========== PLAYER SELECTED =========="
                            )

                            console.log(
                                "Player:",
                                fullName
                            )

                            console.log(
                                "ID:",
                                playerData.id
                            )

                            console.log(
                                "EO:",
                                playerData.selected_by_percent +
                                "%"
                            )


                            playerSearch.value =
                                fullName


                            playerOptions.innerHTML =
                                ""
                        }
                    )


                    playerOptions.appendChild(
                        playerOption
                    )
                }
            )
        }
    )
}


// ==================================================
// ==================================================
// FIND USER'S TIER IN CACHED DATA
// ==================================================

function findUserTier(rankTier) {

    if (
        !sampleData ||
        !Array.isArray(
            sampleData.bands
        )
    ) {

        return null
    }

    return sampleData.bands.find(
        function (band) {

            return (
                band.band === rankTier
            )
        }
    )
}// ==================================================
// FIND PLAYER PICK
// ==================================================

function findPlayerPick(
    manager,
    playerId
) {

    if (
        !Array.isArray(
            manager.picks
        )
    ) {

        return null
    }


    return manager.picks.find(
        function (pick) {

            return (
                String(
                    pick.element
                ) === playerId
            )
        }
    )
}


// ==================================================
// ==================================================
// // ==================================================
// // ==================================================
// CHECK RISK
// ==================================================

checkRisk.addEventListener(
    "click",
    async function () {

        // ----------------------------------------------
        // GET SAVED FPL ID
        // ----------------------------------------------

        const userFplId =
            localStorage.getItem("fplId")


        // ----------------------------------------------
        // VALIDATE FPL ID
        // ----------------------------------------------

        if (!userFplId) {

            console.log(
                "Please register your FPL ID first."
            )

            return
        }


        // ----------------------------------------------
        // VALIDATE PLAYER
        // ----------------------------------------------

        if (!selectedPlayer) {

            console.log(
                "Please select a player."
            )

            return
        }


        // ----------------------------------------------
          
    )        // VALIDATE OWNERSHIP
        // ----------------------------------------------

        if (ownsPlayer === null) {

            console.log(
                "Please select YES or NO for ownership."
            )

            return
        }


        // ----------------------------------------------
        // VALIDATE CAPTAINCY
        // ----------------------------------------------

        if (captainsPlayer === null) {

            console.log(
                "Please select YES or NO for captaincy."
            )

            return
        }


        // ----------------------------------------------
        // VALIDATE TRIPLE CAPTAINCY
        // ----------------------------------------------

        if (tripleCaptainsPlayer === null) {

            console.log(
                "Please select YES or NO for Triple Captaincy."
            )

            return
        }


        // ----------------------------------------------
        // GET EXPECTED POINTS
        // ----------------------------------------------

        const playerPoints =
            Number(
                points.value
            )


        // ----------------------------------------------
        // VALIDATE EXPECTED POINTS
        // ----------------------------------------------

        if (
            !Number.isFinite(playerPoints) ||
            playerPoints < 0
        ) {

            console.log(
                "Please enter valid expected points."
            )

            return
        }


        // ----------------------------------------------
        // CHECK SAMPLE DATA
        // ----------------------------------------------

        if (!sampleData) {

            console.log(
                "Risk data is not ready yet."
            )

            return
        }


        // ----------------------------------------------
        // GET CURRENT FPL RANK
        // ----------------------------------------------

        try {

            console.log(
                "Getting your current FPL rank..."
            )


            const response =
                await fetch(
                    BACKEND_URL +
                    "/api/entry/" +
                    userFplId
                )


            if (!response.ok) {

                throw new Error(
                    "Could not fetch your current FPL rank."
                )
            }


            const data =
                await response.json()


            // ------------------------------------------
            // CURRENT GLOBAL RANK
            // ------------------------------------------

            const globalRank =
                Number(
                    data.overallRank
                )


            if (
                !Number.isFinite(globalRank) ||
                globalRank <= 0
            ) {

                throw new Error(
                    "Current global rank is not available."
                )
            }


            console.log(
                "Current Global Rank:",
                globalRank
            )


            // ------------------------------------------
            // CURRENT RANK TIER
            // ------------------------------------------

            const rankTier =
                getRankTier(
                    globalRank
                )


            if (!rankTier) {

                throw new Error(
                    "Could not determine your current rank tier."
                )
            }


            console.log(
                "Current Rank Tier:",
                rankTier
            )


            // ------------------------------------------
            // FIND CURRENT USER'S TIER
            // ------------------------------------------

            const tierData =
                sampleData.bands.find(
                    function (tier) {

                        return (
                            tier.band === rankTier
                        )
                    }
                )


            console.log(
                "========== CHECK RISK DATA =========="
            )

            console.log(
                "FPL ID:",
                userFplId
            )

            console.log(
                "Current Global Rank:",
                globalRank
            )

            console.log(
                "Current Rank Tier:",
                rankTier
            )

            console.log(
                "Tier data found:",
                tierData
            )


            // ------------------------------------------
              
}            // VALIDATE TIER DATA
            // ------------------------------------------

            if (!tierData) {

                console.log(
                    "Your current rank tier is not available."
                )

                console.log(
                    "Your current tier:",
                    rankTier
                )

                console.log(
                    "Available tiers:",
                    sampleData.bands.map(
                        function (tier) {
                            return tier.band
                        }
                    )
                )

                return
            }


            console.log(
                "Managers in tier:",
                tierData.managers.length
            )


            // ------------------------------------------
            // PLAYER ID
            // ------------------------------------------

            const playerId =
                String(
                    selectedPlayer.id
                )


            // ------------------------------------------
            // YOUR MULTIPLIER
            // ------------------------------------------

            let yourMultiplier = 0


            if (ownsPlayer === true) {

                yourMultiplier = 1


                if (captainsPlayer === true) {

                    yourMultiplier = 2


                    if (
                        tripleCaptainsPlayer === true
                    ) {

                        yourMultiplier = 3
                    }
                }
            }


            // ------------------------------------------
            // YOUR POINTS
            // ------------------------------------------

            const yourPoints =
                playerPoints *
                yourMultiplier


            // ------------------------------------------
            // SAMPLE STATISTICS
            // ------------------------------------------

            let managersWithPlayer = 0

            let managersWithoutPlayer = 0

            let managersCaptainingPlayer = 0

            let totalPointDifference = 0

            let comparisons = 0

            let totalEffectiveOwnership = 0


            // ------------------------------------------
            // COMPARE AGAINST SAMPLE MANAGERS
            // ------------------------------------------

            tierData.managers.forEach(
                function (manager) {

                    if (
                        !Array.isArray(
                            manager.picks
                        )
                    ) {

                        return
                    }


                    const playerPick =
                        manager.picks.find(
                            function (pick) {

                                return (
                                    String(
                                        pick.element
                                    ) === playerId
                                )
                            }
                        )


                    // ----------------------------------
                    // OWNERSHIP
                    // ----------------------------------

                    if (playerPick) {

                        managersWithPlayer++


                        if (
                            playerPick.is_captain === true
                        ) {

                            managersCaptainingPlayer++
                        }


                        totalEffectiveOwnership +=
                            Number(
                                playerPick.multiplier
                            ) || 1

                    } else {

                        managersWithoutPlayer++
                    }


                    // ----------------------------------
                    // MANAGER MULTIPLIER
                    // ----------------------------------

                    let managerMultiplier = 0


                    if (playerPick) {

                        managerMultiplier =
                            Number(
                                playerPick.multiplier
                            ) || 1
                    }


                    // ----------------------------------
                    // MANAGER POINTS
                    // ----------------------------------

                    const managerPoints =
                        playerPoints *
                        managerMultiplier


                    // ----------------------------------
                    // POINT DIFFERENCE
                    // ----------------------------------

                    const difference =
                        yourPoints -
                        managerPoints


                    totalPointDifference +=
                        difference

                    comparisons++
                }
            )


            // ------------------------------------------
            // AVERAGE POINT SWING
            // ------------------------------------------

            let averagePointSwing = 0


            if (comparisons > 0) {

                averagePointSwing =
                    Number(
                        (
                            totalPointDifference /
                            comparisons
                        ).toFixed(1)
                    )
            }


            // ------------------------------------------
            // PLAYER EFFECTIVE OWNERSHIP
            // ------------------------------------------

            const playerEO =
                comparisons > 0
                    ? Number(
                        (
                            totalEffectiveOwnership /
                            comparisons *
                            100
                        ).toFixed(1)
                    )
                    : 0


            // ------------------------------------------
            // SAMPLE OWNERSHIP %
            // ------------------------------------------

            const sampleOwnershipPercent =
                comparisons > 0
                    ? Number(
                        (
                            managersWithPlayer /
                            comparisons *
                            100
                        ).toFixed(1)
                    )
                    : 0


            // ------------------------------------------
            // SAMPLE CAPTAINCY %
            // ------------------------------------------

            const sampleCaptainPercent =
                comparisons > 0
                    ? Number(
                        (
                            managersCaptainingPlayer /
                            comparisons *
                            100
                        ).toFixed(1)
                    )
                    : 0


            // ------------------------------------------
            // RISK DIRECTION
            // ------------------------------------------

            let resultMessage = ""


            if (averagePointSwing > 0) {

                resultMessage =
                    "You gain points against the sampled managers."

            } else if (averagePointSwing < 0) {

                resultMessage =
                    "You lose points against the sampled managers."

            } else {

                resultMessage =
                    "There is no points swing against the sampled managers."
            }


            // ------------------------------------------
            // CONSOLE OUTPUT
            //
              // CONSOLE OUTPUT
            // ------------------------------------------

            console.log(
                "========== FPL RISK =========="
            )

            console.log(
                "Player:",
                selectedPlayer.first_name,
                selectedPlayer.second_name
            )

            console.log(
                "Player EO:",
                playerEO + "%"
            )

            console.log(
                "FPL ID:",
                userFplId
            )

            console.log(
                "Global Rank:",
                globalRank
            )

            console.log(
                "Rank Tier:",
                rankTier
            )

            console.log(
                "Managers sampled:",
                comparisons
            )

            console.log(
                "Managers owning:",
                managersWithPlayer
            )

            console.log(
                "Managers without player:",
                managersWithoutPlayer
            )

            console.log(
                "Managers captaining:",
                managersCaptainingPlayer
            )

            console.log(
                "Sample ownership:",
                sampleOwnershipPercent + "%"
            )

            console.log(
                "Sample captaincy:",
                sampleCaptainPercent + "%"
            )

            console.log(
                "Differential:",
                averagePointSwing + " points"
            )

            console.log(
                "Own player:",
                ownsPlayer
            )

            console.log(
                "Captain player:",
                captainsPlayer
            )

            console.log(
                "Triple Captain player:",
                tripleCaptainsPlayer
            )

            console.log(
                "Expected points:",
                playerPoints
            )

            console.log(
                "Your expected points with multiplier:",
                yourPoints
            )

            console.log(
                "Result:",
                resultMessage
            )


            // ------------------------------------------
            // DISPLAY RESULT ON PAGE
            // ------------------------------------------

            if (riskResult) {

                riskResult.innerHTML = `
                    <h2>Risk Result</h2>

                    <p>
                        <strong>
                            ${selectedPlayer.first_name}
                            ${selectedPlayer.second_name}
                        </strong>
                    </p>

                    <p>
                        Your rank:
                        <strong>${globalRank}</strong>
                    </p>

                    <p>
                        Rank tier:
                        <strong>${rankTier}</strong>
                    </p>

                    <p>
                        Player EO:
                        <strong>${playerEO}%</strong>
                    </p>

                    <p>
                        Sample ownership:
                        <strong>${sampleOwnershipPercent}%</strong>
                    </p>

                    <p>
                        Differential:
                        <strong>${averagePointSwing} points</strong>
                    </p>

                    <p>
                        Sample captaincy:
                        <strong>${sampleCaptainPercent}%</strong>
                    </p>

                    <p>
                        Expected points:
                        <strong>${playerPoints}</strong>
                    </p>

                    <p>
                        Your points:
                        <strong>${yourPoints}</strong>
                    </p>

                    <p>
                        ${resultMessage}
                    </p>
                `
            }


        } catch (error) {

            console.error(
                "Risk check failed:",
                error
            )

            if (riskResult) {

                riskResult.textContent =
                    "Risk check failed: " +
                    error.message
            }
        }
    }
)



// ==================================================
