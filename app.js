const express = require("express")
const bodyParser = require("body-parser")
const cors = require("cors")
const bcrypt = require("bcrypt")
const jwt = require("jsonwebtoken")
const admin = require("firebase-admin")
require("dotenv").config()

const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY)

const DATABASE_URL = process.env.DATABASE_URL
console.log(DATABASE_URL)

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DATABASE_URL,
})

const database = admin.database()

const app = express()
const PORT = 3000
const SECRET_KEY = process.env.SECRET_KEY

app.use(cors())
app.use(bodyParser.json())

// Signup Route
app.post("/api/signup", async (req, res) => {
    try {
        const { name, email, password, mrn } = req.body

        const userRef = database.ref("users").orderByChild("email").equalTo(email)
        userRef.once("value", async (snapshot) => {
            if (snapshot.exists()) {
                return res.status(400).json({ message: "Email already exists" })
            }

            // Generate a unique 10-digit UIN
            let uin
            let uinExists
            do {
                uin = Math.floor(1000000000 + Math.random() * 9000000000).toString()
                const uinSnapshot = await database
                    .ref("users")
                    .orderByChild("uin")
                    .equalTo(uin)
                    .once("value")
                uinExists = uinSnapshot.exists()
            } while (uinExists)

            // Hash the password
            const hashedPassword = await bcrypt.hash(password, 10)

            // Store user details with UIN
            const newUserRef = database.ref("users").push()
            await newUserRef.set({
                name,
                email,
                passwordHash: hashedPassword,
                uin,
                mrn,
            })

            res.json({ message: "Signup successful", uin })
        })
    } catch (error) {
        console.error(error)
        res.status(500).json({ message: "Internal server error" })
    }
})

// Login Route
app.post("/api/login", async (req, res) => {
    try {
        const { email, password } = req.body

        const userRef = database.ref("users").orderByChild("email").equalTo(email)
        userRef.once("value", async (snapshot) => {
            const user = snapshot.val() ? Object.values(snapshot.val())[0] : null

            if (user && (await bcrypt.compare(password, user.passwordHash))) {
                const token = jwt.sign({ email }, SECRET_KEY, { expiresIn: "1h" })
                res.json({ message: "Login successful", token })
            } else {
                res.status(401).json({ message: "Invalid credentials" })
            }
        })
    } catch (error) {
        console.error(error)
        res.status(500).json({ message: "Internal server error" })
    }
})

// Verify UIN Route
app.post("/api/verify-uin", async (req, res) => {
    const { uin } = req.body

    try {
        // Query the database for the user with the given UIN
        const userSnapshot = await admin
            .database()
            .ref("users")
            .orderByChild("uin")
            .equalTo(uin)
            .once("value")

        if (userSnapshot.exists()) {
            const userData = userSnapshot.val()
            // Assuming there's only one user with that UIN
            const user = Object.values(userData)[0]
            res.status(200).json({ success: true, user })
        } else {
            res.status(404).json({ success: false, message: "UIN not found" })
        }
    } catch (error) {
        console.error(error)
        res.status(500).json({ message: "Internal server error" })
    }
})

// Verify MRN Route
app.post("/api/verify-mrn", (req, res) => {
    const { uin, mrnLastThreeDigits } = req.body

    const patientRef = database.ref("patients").orderByChild("uin").equalTo(uin)

    patientRef.once("value", (snapshot) => {
        if (snapshot.exists()) {
            const patients = snapshot.val()
            const patientList = Object.values(patients) // Convert the object to an array

            // Find the patient whose MRN ends with the provided digits
            const patient = patientList.find((p) => p.mrn.endsWith(mrnLastThreeDigits))

            if (patient) {
                res.status(200).json({ success: true, patient })
            } else {
                res.status(404).json({
                    success: false,
                    message: "MRN does not match or patient not found",
                })
            }
        } else {
            res.status(404).json({
                success: false,
                message: "Patient with the given UIN not found",
            })
        }
    })
})

// Get Patient Data Route
app.get("/api/get-patient-data", (req, res) => {
    const { uin } = req.body
    const patientRef = database.ref("users").orderByChild("uin").equalTo(uin)

    patientRef.once("value", (snapshot) => {
        const patient = snapshot.val() ? Object.values(snapshot.val())[0] : null
        if (patient) {
            res.json(patient)
        } else {
            res.status(404).json({ error: "Patient not found" })
        }
    })
})

// Book Room Route
app.post("/api/book-room", (req, res) => {
    const { patientName, phone, roomType, admissionDate, numberOfDays } = req.body

    // Generate a unique room number
    const generateUniqueRoomNumber = async () => {
        let roomNumber
        let roomExists
        do {
            roomNumber = Math.floor(1 + Math.random() * 10) // Generates a number between 1 and 10
            const roomSnapshot = await database.ref("bookedRooms").child(roomNumber).once("value")
            roomExists = roomSnapshot.exists()
        } while (roomExists)

        return roomNumber
    }

    generateUniqueRoomNumber()
        .then((roomNumber) => {
            const bookedRoom = {
                roomNumber,
                patientName,
                phone,
                roomType,
                admissionDate,
                numberOfDays,
                totalCost: calculateTotalCost(roomType, numberOfDays),
            }

            const bookedRoomRef = database.ref("bookedRooms").child(roomNumber)
            bookedRoomRef.set(bookedRoom, (error) => {
                if (error) {
                    res.status(500).json({ message: "Failed to book room" })
                } else {
                    console.log(`Message sent to ${phone}: Room booked successfully`)
                    res.status(201).json({ message: "Room booked successfully", bookedRoom })
                }
            })
        })
        .catch((error) => {
            console.error(error)
            res.status(500).json({ message: "Internal server error" })
        })
})

// Get Booked Rooms Route
app.get("/api/booked-rooms", (req, res) => {
    database.ref("bookedRooms").once("value", (snapshot) => {
        const roomsData = snapshot.val()
        const bookedRooms = roomsData
            ? Object.values(roomsData).filter((room) => room !== null)
            : []
        res.json(bookedRooms)
    })
})

// Cancel Room Booking Route
app.post("/api/cancel-room", (req, res) => {
    const { roomNumber, uin, cancellationReason } = req.body
    const roomRef = database.ref("bookedRooms").child(roomNumber)

    roomRef.once("value", (snapshot) => {
        if (snapshot.exists()) {
            roomRef.remove((error) => {
                if (error) {
                    res.status(500).json({ message: "Failed to cancel room" })
                } else {
                    res.json({
                        message: "Room booking cancelled successfully",
                        cancelledRoom: snapshot.val(),
                    })
                }
            })
        } else {
            res.status(404).json({ message: "Room not found" })
        }
    })
})

// Calculate Total Cost Function
function calculateTotalCost(roomType, numberOfDays) {
    const costPerDayMap = {
        Special: 1200,
        "Class A": 1000,
        "Class B": 800,
        "Class C": 700,
        "Class D": 600,
    }

    const costPerDay = costPerDayMap[roomType] || 600
    return costPerDay * numberOfDays
}

// Start the Server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`)
})
