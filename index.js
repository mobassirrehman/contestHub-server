const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const admin = require("firebase-admin");

const serviceAccount = require("./firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Middlewares
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.0zmmwcn.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const verifyToken = async (req, res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    return res.status(401).send({ message: "Unauthorized access" });
  }

  const token = authorization.split(" ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded = decoded;
    next();
  } catch (error) {
    return res.status(401).send({ message: "Invalid Token" });
  }
};

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const database = client.db("contestHubDB");
    const usersCollection = database.collection("users");
    const contestsCollection = database.collection("contests");
    const participantsCollection = database.collection("participants");
    const paymentsCollection = database.collection("payments");

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email: email });
      if (user?.role !== "admin") {
        return res.status(403).send({ message: "Forbidden access" });
      }
      next();
    };

    const verifyCreator = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email: email });
      if (user?.role !== "creator" && user?.role !== "admin") {
        return res.status(403).send({ message: "Forbidden access" });
      }
      next();
    };

    //User Routes
    app.post("/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await usersCollection.findOne(query);

      if (existingUser) {
        return res.send({ message: "User already exists", insertedId: null });
      }

      user.role = "user";
      user.createdAt = new Date();

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const searchText = req.query.searchText || "";
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;

      const query = searchText
        ? {
            $or: [
              { displayName: { $regex: searchText, $options: "i" } },
              { email: { $regex: searchText, $options: "i" } },
            ],
          }
        : {};

      const total = await usersCollection.countDocuments(query);
      const users = await usersCollection
        .find(query)
        .skip(skip)
        .limit(limit)
        .toArray();

      res.send({
        users,
        totalPages: Math.ceil(total / limit),
        currentPage: page,
        totalUsers: total,
      });
    });

    app.get("/users/:email/role", verifyToken, async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    app.get("/users/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      res.send(user);
    });

    app.patch("/users/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const updateData = req.body;
      const filter = { email: email };
      const updateDoc = {
        $set: updateData,
      };
      const result = await usersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    app.patch("/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: { role: role },
      };
      const result = await usersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    //  Contest Routes(Creator only)
    app.post("/contests", verifyToken, verifyCreator, async (req, res) => {
      const contest = req.body;
      contest.status = "pending"; // pending, approved, rejected
      contest.participantsCount = 0;
      contest.createdAt = new Date();

      const result = await contestsCollection.insertOne(contest);
      res.send(result);
    });

    app.get("/contests", async (req, res) => {
      const type = req.query.type;
      const search = req.query.search;

      let query = { status: "approved" };

      if (type && type !== "all") {
        query.type = type;
      }

      if (search) {
        query.name = { $regex: search, $options: "i" };
      }

      const result = await contestsCollection.find(query).toArray();
      res.send(result);
    });
    // Get popular contests (sorted by participants)
    app.get("/contests/popular", async (req, res) => {
      const result = await contestsCollection
        .find({ status: "approved" })
        .sort({ participantsCount: -1 })
        .limit(6)
        .toArray();
      res.send(result);
    });

    app.get("/contests/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await contestsCollection.findOne(query);
      res.send(result);
    });

    app.get(
      "/contests/creator/:email",
      verifyToken,
      verifyCreator,
      async (req, res) => {
        const email = req.params.email;
        const query = { creatorEmail: email };
        const result = await contestsCollection.find(query).toArray();
        res.send(result);
      }
    );

    app.patch("/contests/:id", verifyToken, verifyCreator, async (req, res) => {
      const id = req.params.id;
      const updateData = req.body;
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: updateData,
      };
      const result = await contestsCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    app.delete("/contests/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await contestsCollection.deleteOne(query);
      res.send(result);
    });

    //Admin contest management
    app.get("/admin/contests", verifyToken, verifyAdmin, async (req, res) => {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;

      const total = await contestsCollection.countDocuments();
      const contests = await contestsCollection
        .find()
        .skip(skip)
        .limit(limit)
        .toArray();

      res.send({
        contests,
        totalPages: Math.ceil(total / limit),
        currentPage: page,
        totalContests: total,
      });
    });
    // Approve/Reject contest (Admin only)
    app.patch(
      "/admin/contests/:id/status",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { status } = req.body;
        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: { status: status },
        };
        const result = await contestsCollection.updateOne(filter, updateDoc);
        res.send(result);
      }
    );

    //Participation Routes
    // / Register for contest (after payment)
    app.post("/participants", verifyToken, async (req, res) => {
      const participant = req.body;
      participant.createdAt = new Date();

      const existing = await participantsCollection.findOne({
        contestId: participant.contestId,
        userEmail: participant.userEmail,
      });

      if (existing) {
        return res.send({ message: "Already registered", insertedId: null });
      }

      const result = await participantsCollection.insertOne(participant);

      if (result.insertedId) {
        await contestsCollection.updateOne(
          { _id: new ObjectId(participant.contestId) },
          { $inc: { participantsCount: 1 } }
        );
      }

      res.send(result);
    });

    app.get("/participants/check", verifyToken, async (req, res) => {
      const { contestId, email } = req.query;
      const existing = await participantsCollection.findOne({
        contestId: contestId,
        userEmail: email,
      });
      res.send({ isRegistered: !!existing, participant: existing });
    });
    // Get user's participated contests
    app.get("/participants/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const query = { userEmail: email };
      const result = await participantsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    app.patch("/participants/:id/submit", verifyToken, async (req, res) => {
      const id = req.params.id;
      const { submittedTask } = req.body;
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          submittedTask: submittedTask,
          submittedAt: new Date(),
        },
      };
      const result = await participantsCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    app.get(
      "/submissions/:contestId",
      verifyToken,
      verifyCreator,
      async (req, res) => {
        const contestId = req.params.contestId;
        const query = {
          contestId: contestId,
          submittedTask: { $exists: true },
        };
        const result = await participantsCollection.find(query).toArray();
        res.send(result);
      }
    );
    // declare winner by creator
    app.patch(
      "/contests/:id/winner",
      verifyToken,
      verifyCreator,
      async (req, res) => {
        const id = req.params.id;
        const { winnerEmail, winnerName, winnerPhoto } = req.body;

        const contestFilter = { _id: new ObjectId(id) };
        const contestUpdate = {
          $set: {
            winnerEmail,
            winnerName,
            winnerPhoto,
            winnerDeclaredAt: new Date(),
          },
        };
        await contestsCollection.updateOne(contestFilter, contestUpdate);

        const participantFilter = {
          contestId: id,
          userEmail: winnerEmail,
        };
        const participantUpdate = {
          $set: { isWinner: true },
        };
        await participantsCollection.updateOne(
          participantFilter,
          participantUpdate
        );

        res.send({ success: true });
      }
    );

    app.get("/winners/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const query = { userEmail: email, isWinner: true };
      const result = await participantsCollection.find(query).toArray();
      res.send(result);
    });

    // Get leaderboard (users ranked by wins)
    app.get("/leaderboard", async (req, res) => {
      const filter = req.query.filter || "all"; // all, month, week

      let matchFilter = { isWinner: true };
      const now = new Date();

      if (filter === "week") {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        matchFilter.wonAt = { $gte: weekAgo };
      } else if (filter === "month") {
        const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        matchFilter.wonAt = { $gte: monthAgo };
      }

      const pipeline = [
        { $match: matchFilter },
        {
          $group: {
            _id: "$userEmail",
            userName: { $first: "$userName" },
            userPhoto: { $first: "$userPhoto" },
            winCount: { $sum: 1 },
            totalPrize: { $sum: { $ifNull: ["$prizeMoney", 0] } },
          },
        },
        { $sort: { winCount: -1, totalPrize: -1 } },
        { $limit: 20 },
      ];

      const result = await participantsCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    //Statistics Routes
    app.get("/stats", async (req, res) => {
      const totalContests = await contestsCollection.countDocuments({
        status: "approved",
      });
      const totalParticipants = await participantsCollection.countDocuments();
      const totalWinners = await participantsCollection.countDocuments({
        isWinner: true,
      });

      const prizePipeline = [
        { $match: { winnerEmail: { $exists: true } } },
        { $group: { _id: null, totalPrize: { $sum: "$prizeMoney" } } },
      ];
      const prizeResult = await contestsCollection
        .aggregate(prizePipeline)
        .toArray();
      const totalPrizeMoney = prizeResult[0]?.totalPrize || 0;

      const recentWinners = await contestsCollection
        .find({ winnerEmail: { $exists: true } })
        .sort({ winnerDeclaredAt: -1 })
        .limit(5)
        .project({ winnerName: 1, winnerPhoto: 1, prizeMoney: 1, name: 1 })
        .toArray();

      res.send({
        totalContests,
        totalParticipants,
        totalWinners,
        totalPrizeMoney,
        recentWinners,
      });
    });

    // Payment Routes
    app.post("/create-payment-intent", verifyToken, async (req, res) => {
      const { contestId, contestName, price, userEmail, userName, userPhoto } =
        req.body;

      const existing = await participantsCollection.findOne({
        contestId: contestId,
        userEmail: userEmail,
      });

      if (existing) {
        return res
          .status(400)
          .send({ message: "Already registered for this contest" });
      }

      try {
        // Create Stripe checkout session
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: contestName,
                  description: `Registration fee for ${contestName}`,
                },
                unit_amount: Math.round(price * 100), // Convert to cents
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}&contestId=${contestId}`,
          cancel_url: `${process.env.CLIENT_URL}/contest/${contestId}?payment=cancelled`,
          customer_email: userEmail,
          metadata: {
            contestId,
            contestName,
            userEmail,
            userName,
            userPhoto: userPhoto || "",
          },
        });

        res.send({ sessionId: session.id, url: session.url });
      } catch (error) {
        console.error("Stripe error:", error);
        res.status(500).send({ message: "Payment initialization failed" });
      }
    });

    // Verify payment
    app.post("/verify-payment", verifyToken, async (req, res) => {
      const { sessionId } = req.body;

      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === "paid") {
          const { contestId, contestName, userEmail, userName, userPhoto } =
            session.metadata;

          const existing = await participantsCollection.findOne({
            contestId: contestId,
            userEmail: userEmail,
          });

          if (existing) {
            return res.send({ success: true, message: "Already registered" });
          }

          // Save payment record
          const paymentRecord = {
            sessionId: session.id,
            contestId,
            contestName,
            userEmail,
            userName,
            amount: session.amount_total / 100,
            currency: session.currency,
            paymentStatus: session.payment_status,
            paidAt: new Date(),
          };
          await paymentsCollection.insertOne(paymentRecord);

          // Register participant
          const participant = {
            contestId,
            contestName,
            userEmail,
            userName,
            userPhoto: userPhoto || "",
            paymentId: session.id,
            createdAt: new Date(),
          };
          await participantsCollection.insertOne(participant);

          // Increment participants count
          await contestsCollection.updateOne(
            { _id: new ObjectId(contestId) },
            { $inc: { participantsCount: 1 } }
          );

          res.send({ success: true, message: "Registration successful" });
        } else {
          res
            .status(400)
            .send({ success: false, message: "Payment not completed" });
        }
      } catch (error) {
        console.error("Payment verification error:", error);
        res.status(500).send({ message: "Payment verification failed" });
      }
    });

    // Get user's payment history
    app.get("/payments/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const query = { userEmail: email };
      const result = await paymentsCollection
        .find(query)
        .sort({ paidAt: -1 })
        .toArray();
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}

run().catch(console.dir);
app.get("/", (req, res) => {
  res.send("ContesHub is on Air!");
});

app.listen(port, () => {
  console.log(`contestHub app listening on port ${port}`);
});
