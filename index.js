const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

require("dotenv").config();
const Stripe = require("stripe");
const admin = require("firebase-admin");
const app = express();
const port = process.env.PORT || 5000;
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.nqjvfag.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

//verify Firebase Token
const verifyFBToken = async (req, res, next) => {
  const authHeader = req.headers?.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({ massage: "Unauthorized access" });
  }
  const token = authHeader.split(" ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded = decoded;

    next();
  } catch {
    return res.status(401).send({ massage: "Unauthorized access" });
  }
};

//Verify Token Email
const verifyTokenEmail = async (req, res, next) => {
  const email = req.params.email;
  if (email !== req.decoded.email) {
    return res.status(403).massage({ massage: "Forbidden access" });
  }
  next();
};

const verifyAdmin = async (req, res, next) => {
  const email = req.decoded.email;
  const query = { email };
  const user = await usersCollection.findOne(query);

  if (!user || user.role !== "admin") {
    return res.status(403).send({ message: "forbidden access" });
  }

  next();
};

async function run() {
  try {
    // await client.connect();
    const usersCollection = client.db("healthHiveDB").collection("users");
    const medicineCollection = client
      .db("healthHiveDB")
      .collection("medicines");
    const orderCollection = client.db("healthHiveDB").collection("orders");

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }

      next();
    };

    //-----Part: 1 Users data API------
    //all users
    app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.send(users);
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch users" });
      }
    });

    //users data post
    app.post("/users/request", async (req, res) => {
      const user = req.body;

      if (!user?.email || !user?.name || !user?.role || !user?.status) {
        return res.status(400).send({ error: "Missing user fields" });
      }

      // Optional: check if user already exists
      const existing = await usersCollection.findOne({ email: user.email });
      if (existing) {
        return res.status(409).send({ message: "User already exists" });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    //set last login
    app.put("/users/update-login-time/:email", async (req, res) => {
      const email = req.params.email;
      let { last_login_time } = req.body;

      // If last_login_time is missing or falsy, set it to current ISO time
      if (!last_login_time) {
        last_login_time = new Date().toISOString();
      }

      try {
        const result = await usersCollection.updateOne(
          { email: email },
          { $set: { last_login_time } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ error: "User not found" });
        }

        res.send({ message: "Last login time updated", last_login_time });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // GET users check email it's for google pop up login
    app.get("/users/check/:email", async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      res.send({ exists: !!user });
    });

    //get pending sellers
    app.get("/applied/sellers", verifyFBToken, async (req, res) => {
      try {
        const pendingSellers = await usersCollection
          .find({
            applying_for: "seller",
            status: "pending",
          })
          .toArray();

        res.send(pendingSellers);
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch seller applications" });
      }
    });

    //user approval api
    app.patch("/user/approval", async (req, res) => {
      const { email, status } = req.body;

      if (!email || !status) {
        return res.status(400).send({ error: "Missing email or status" });
      }

      try {
        const updateDoc = {
          $set: {
            status,
            role: status === "approved" ? "seller" : "user",
          },
        };

        const result = await usersCollection.updateOne({ email }, updateDoc);

        if (result.matchedCount === 0) {
          return res.status(404).send({ error: "User not found" });
        }

        res.send({ success: true, message: `User ${status}` });
      } catch (error) {
        res.status(500).send({ error: "Failed to update user approval" });
      }
    });

    // Get all seller role=seller and status=approved
    app.get("/sellers/all", verifyFBToken, async (req, res) => {
      try {
        const sellers = await usersCollection
          .find({ role: "seller", status: "approved" })
          .toArray();
        res.send(sellers);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch sellers" });
      }
    });

    // GET single user by email
    app.get(
      "/users/:email",
      verifyFBToken,
      verifyTokenEmail,
      async (req, res) => {
        const email = req.params.email;

        if (!email) {
          return res.status(400).send({ error: "Email is required" });
        }

        try {
          const user = await usersCollection.findOne({ email });

          if (!user) {
            return res.status(404).send({ error: "User not found" });
          }

          res.send(user);
        } catch (error) {
          res.status(500).send({ error: "Server error" });
        }
      }
    );

    //------------ Medicine API ------------------
    //add medicines
    app.post("/medicine/post", async (req, res) => {
      try {
        const {
          seller_id,
          seller_name,
          seller_email,
          name,
          generic_name,
          description,
          image,
          category,
          company,
          mass_unit,
          price,
          discount,
        } = req.body;

        if (!seller_email) {
          return res.status(400).json({ message: "Missing seller email" });
        }

        // Check user role
        const user = await usersCollection.findOne({ email: seller_email });

        if (!user || user.role !== "seller") {
          return res
            .status(403)
            .json({ message: "Only sellers can post medicine" });
        }

        // Prepare medicine object
        const newMedicine = {
          name,
          generic_name,
          description,
          image,
          category,
          company,
          mass_unit,
          price,
          discount,
          seller_id,
          seller_name: seller_name || user.name || "Unknown Seller",
          seller_email,
          created_time: new Date(),
          updated_time: new Date(),
        };

        // Insert to DB
        const result = await medicineCollection.insertOne(newMedicine);
        res.status(201).json(result);
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    //get all medicines
    app.get("/medicines", async (req, res) => {
      try {
        const medicines = await medicineCollection.find().toArray();
        res.send(medicines);
      } catch (err) {
        res
          .status(500)
          .send({ message: "Failed to fetch medicines", error: err.message });
      }
    });

    // GET seller's added medicines
    app.get(
      "/medicine/seller/:email",
      verifyFBToken,
      verifyTokenEmail,
      async (req, res) => {
        try {
          const email = req.params.email;
          if (!email) {
            return res.status(400).json({ message: "Missing seller email" });
          }

          const medicines = await medicineCollection
            .find({ seller_email: email })
            .toArray();
          res.status(200).json(medicines);
        } catch (error) {
          res.status(500).json({ message: "Internal server error" });
        }
      }
    );

    //update seller added medicines
    app.put("/medicine/update/:id", async (req, res) => {
      const medicineId = req.params.id;
      const updatedData = req.body;
      const userEmail = req.body.seller_email; // email must be sent in the request body

      try {
        // 1. Check if the user exists and is a seller
        const user = await usersCollection.findOne({ email: userEmail });

        if (!user || user.role !== "seller") {
          return res.status(403).json({
            message: "Access denied. Only sellers can update medicines.",
          });
        }

        // 2. Check if the medicine belongs to this seller
        const medicine = await medicineCollection.findOne({
          _id: new ObjectId(medicineId),
        });

        if (!medicine || medicine.seller_email !== userEmail) {
          return res.status(403).json({
            message: "You are not authorized to update this medicine.",
          });
        }

        // 3. Update the medicine
        const result = await medicineCollection.updateOne(
          { _id: new ObjectId(medicineId) },
          { $set: updatedData }
        );

        res.send(result);
      } catch (error) {
        res.status(500).json({ message: "Internal server error." });
      }
    });

    //delete seller medicine
    app.delete("/medicine/:id", async (req, res) => {
      const medicineId = req.params.id;
      const { seller_email } = req.body;

      try {
        // 1. Find the user and check their role
        const user = await usersCollection.findOne({ email: seller_email });
        if (!user || user.role !== "seller") {
          return res.status(403).json({
            message: "Access denied. Only sellers can delete medicines.",
          });
        }

        // 2. Check that the medicine belongs to this seller
        const medicine = await medicineCollection.findOne({
          _id: new ObjectId(medicineId),
        });

        if (!medicine || medicine.seller_email !== seller_email) {
          return res.status(403).json({
            message: "You are not authorized to delete this medicine.",
          });
        }

        // 3. Delete it
        const result = await medicineCollection.deleteOne({
          _id: new ObjectId(medicineId),
        });

        res.send(result);
      } catch (error) {
        res.status(500).json({ message: "Internal server error." });
      }
    });

    //------------ Update Medicines by Admin -------------
    app.patch("/admin/medicine/update/:id", async (req, res) => {
      try {
        const medicineId = req.params.id;
        const { email } = req.query;
        const updateData = req.body;

        // 1. Check if email is provided
        if (!email) {
          return res
            .status(400)
            .json({ message: "Missing admin email in query." });
        }

        // 2. Find the user
        const adminUser = await usersCollection.findOne({ email });

        if (!adminUser || adminUser.role !== "admin") {
          return res
            .status(403)
            .json({ message: "Unauthorized. Admin access required." });
        }

        // 3. Perform the update
        const result = await medicineCollection.updateOne(
          { _id: new ObjectId(medicineId) },
          {
            $set: {
              ...updateData,
              updatedAt: new Date(),
            },
          }
        );

        if (result.modifiedCount > 0) {
          return res
            .status(200)
            .json({ message: "Medicine updated successfully.", result });
        } else {
          return res
            .status(404)
            .json({ message: "Medicine not found or no changes made." });
        }
      } catch (error) {
        return res
          .status(500)
          .json({ message: "Internal Server Error", error });
      }
    });

    //------------- DELETE Medicines by Admin -------------
    app.delete("/admin/medicine/delete/:id", async (req, res) => {
      try {
        const medicineId = req.params.id;
        const { email } = req.query;

        if (!email) {
          return res
            .status(400)
            .json({ message: "Missing admin email in query." });
        }

        if (!ObjectId.isValid(medicineId)) {
          return res.status(400).json({ message: "Invalid medicine ID." });
        }

        const adminUser = await usersCollection.findOne({ email });

        if (!adminUser || adminUser.role !== "admin") {
          return res
            .status(403)
            .json({ message: "Unauthorized. Admin access required." });
        }

        const result = await medicineCollection.deleteOne({
          _id: new ObjectId(medicineId),
        });

        if (result.deletedCount > 0) {
          return res
            .status(200)
            .json({ message: "Medicine deleted successfully.", result });
        } else {
          return res.status(404).json({ message: "Medicine not found." });
        }
      } catch (error) {
        return res.status(500).json({
          message: "Internal Server Error",
          error: error?.message,
        });
      }
    });

    // Discount
    app.get("/medicines/discount", async (req, res) => {
      try {
        const discountedMedicines = await medicineCollection
          .find({ discount: { $gt: 0 } })
          .sort({ _id: -1 }) 
          .toArray();

        res.send(discountedMedicines);
      } catch (error) {
        res.status(500).json({ message: "Internal server error." });
      }
    });

    //-------- Orders and Payment ------------------------
    //order medicine
    app.post("/order-medicine", async (req, res) => {
      const order = req.body;
      order.order_time = new Date();

      try {
        const result = await orderCollection.insertOne(order);
        res.status(201).send(result);
      } catch (err) {
        res
          .status(500)
          .send({ message: "Failed to place order", error: err.message });
      }
    });

    // GET: Orders by Customer Email
    app.get(
      "/cart/:email",
      verifyFBToken,
      verifyTokenEmail,
      async (req, res) => {
        const email = req.params.email;

        try {
          const orders = await orderCollection
            .find({
              customer_email: email,
              order_status: "pending",
              payment_status: "pending",
            })
            .toArray();

          res.send(orders);
        } catch (error) {
          res
            .status(500)
            .send({ message: "Failed to fetch cart items", error });
        }
      }
    );

    // PATCH: Change quantity
    app.patch("/cart/quantity/:id", async (req, res) => {
      const id = req.params.id;
      const { quantity } = req.body;
      const result = await orderCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { quantity: quantity } }
      );
      res.send(result);
    });

    // DELETE: Remove single item
    app.delete("/cart/remove/:id", async (req, res) => {
      const id = req.params.id;
      const result = await orderCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // DELETE: Clear all cart for this user
    app.delete("/cart/clear/:email", async (req, res) => {
      const result = await orderCollection.deleteMany({
        customer_email: req.params.email,
        order_status: "pending",
        payment_status: "pending",
      });
      res.send(result);
    });

    //single order
    app.get("/single-order/:id", verifyFBToken, async (req, res) => {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ error: "Invalid order ID" });
      }

      try {
        const order = await orderCollection.findOne({ _id: new ObjectId(id) });

        if (!order) {
          return res.status(404).send({ error: "Order not found" });
        }

        res.send(order);
      } catch (error) {
        res
          .status(500)
          .send({ error: "Failed to fetch order", message: error.message });
      }
    });

    //-------------- payments --------------
    app.post("/create-payment-intent", async (req, res) => {
      const { amount } = req.body;

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100), // convert to cents and ensure it's integer
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).send({ message: "Failed to create payment intent." });
      }
    });

    app.patch("/cart/confirm-payment/:id", async (req, res) => {
      const id = req.params.id;
      const { payment_status, order_status, payment, transactionId } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ error: "Invalid order ID" });
      }

      if (!payment_status || !order_status || !payment || !transactionId) {
        return res
          .status(400)
          .send({ error: "Missing required payment fields" });
      }

      try {
        const result = await orderCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              payment_status,
              order_status,
              payment,
              transactionId,
              payment_time: new Date(),
            },
          }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ error: "Order not found" });
        }

        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to confirm payment" });
      }
    });

    //---------- get users -----------
    app.get(
      "/payments/history/:email",
      verifyFBToken,
      verifyTokenEmail,
      async (req, res) => {
        try {
          const email = req.params.email;
          if (!email) {
            return res
              .status(400)
              .json({ error: "Email parameter is required" });
          }

          const payments = await orderCollection
            .find({ customer_email: email, payment_status: "confirmed" }) // Only confirmed payments
            .toArray();

          res.status(200).json({ payments });
        } catch (error) {
          res.status(500).json({ error: "Internal Server Error" });
        }
      }
    );

    //----------- seller payment history---------
    app.get(
      "/seller/payment-history/:email",
      verifyFBToken,
      verifyTokenEmail,
      async (req, res) => {
        try {
          const sellerEmail = req.params.email;

          const payments = await orderCollection
            .find({ seller_email: sellerEmail, payment_status: "confirmed" })
            .sort({ payment_date: -1 }) // Optional: recent first
            .toArray();

          res.send(payments);
        } catch (error) {
          e.error("Error fetching seller payment history:", error);
          res.status(500).send({ message: "Internal Server Error" });
        }
      }
    );

    // Inside your Express route file admin
    app.get(
      "/admin/payments/all-confirmed",
      verifyFBToken,
      async (req, res) => {
        try {
          const email = req.query.email;

          // 1. Validate admin user
          const adminUser = await usersCollection.findOne({ email });
          if (!adminUser || adminUser.role !== "admin") {
            return res.status(403).send({ message: "Forbidden: Not an admin" });
          }

          // 2. Get all confirmed payments
          const confirmedOrders = await orderCollection
            .find({ payment_status: "confirmed" })
            .toArray();

          res.send(confirmedOrders);
        } catch (error) {
          res.status(500).send({ message: "Internal Server Error" });
        }
      }
    );

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("HealthHive Rent Server is Ok");
});

app.listen(port, () => {
  console.log(`HealthHive Server running on port ${port}`);
});
