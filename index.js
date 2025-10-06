require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const { supabase } = require("./supabaseClient");
const omise = require("omise")({
  publicKey: process.env.OMISE_PUBLIC_KEY,
  secretKey: process.env.OMISE_SECRET_KEY,
});
const app = express();
const port = process.env.PORT || 4000;

app.use(
  cors({
    origin: "*",
  })
);
app.use(bodyParser.json());

const sendToSupabase = async (
  amount,
  transactionId,
  payniUserId,
  isFound,
  currencyId
) => {
  try {
    const res = await supabase.from("transactions").insert({
      amount: amount,
      transaction_id: transactionId,
      payni_user_id: payniUserId,
      is_found: isFound,
      currency_id: currencyId,
    });
  } catch (error) {
    console.log(error);
  }
};

// Function to verify charge status
const verifyChargeStatus = async (chargeId) => {
  try {
    const charge = await omise.charges.retrieve(chargeId);
    return charge.status === "successful";
  } catch (error) {
    console.log("Error retrieving charge:", error);
    return false;
  }
};

app.post("/webhook", async (req, res) => {
  const event = req.body;

  // Log the received event
  console.log("Received event:", event);

  // Check the event type
  if (event.object === "event") {
    if (event.data.status === "successful") {
      const chargeId = event.data.id;
      const amount = event.data.amount / 100;
      const payniUserId = event.data.metadata.payniUserId;
      const currencyId = event.data.metadata.currencyId;
      const isSuccessful = await verifyChargeStatus(chargeId);
      if (isSuccessful) {
        console.log("Charge is successful:", event.data);
        await sendToSupabase(amount, chargeId, payniUserId, false, currencyId);
      } else {
        console.log("Charge is not successful:", chargeId);
      }
    } else {
      console.log("Charge:", event.data);
    }
  }

  res.status(200).send("OK");
});

app.post("/create-charge", async (req, res) => {
  if (req.method === "POST") {
    try {
      const { amount, payniUserId, currencyId } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount is required." });
      }

      const charge = await omise.charges.create({
        amount: amount,
        metadata: {
          payniUserId: payniUserId,
          currencyId: currencyId,
        },
        currency: "thb",
        source: {
          type: "promptpay",
        },
      });
      res.status(200).json(charge);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  } else {
    res.setHeader("Allow", ["POST"]);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
});

app.post("/charge-paid", async (req, res) => {
  if (req.method === "POST") {
    try {
      const { chargeId } = req.body;

      // Mark the payout as sent
      const markAsPaid = await axios.post(
        `https://api.omise.co/charges/${chargeId}/mark_as_paid`,
        {},
        {
          auth: {
            username: process.env.OMISE_SECRET_KEY,
            password: "",
          },
        }
      );
      res.status(200).json("Success");
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  } else {
    res.setHeader("Allow", ["POST"]);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
});

app.post("/create-recipient", async (req, res) => {
  if (req.method === "POST") {
    try {
      const { name, bankAccount } = req.body;

      // Validate input
      if (!name || !bankAccount) {
        return res
          .status(400)
          .json({ error: "Email, and bank account details are required." });
      }

      const recipient = await omise.recipients.create({
        name: name,
        type: "individual",
        bank_account: {
          brand: bankAccount.brand,
          number: bankAccount.number,
          name: bankAccount.name,
        },
      });

      res.status(200).json(recipient);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  } else {
    res.setHeader("Allow", ["POST"]);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
});

app.post("/create-payout", async (req, res) => {
  if (req.method === "POST") {
    let recipient = null;
    let payout = null;
    try {
      const { name, bankAccount, amount } = req.body;

      // Validate input
      if (!name || !bankAccount || !amount || amount <= 0) {
        return res
          .status(400)
          .json({ error: "All fields are required and amount must be valid." });
      }

      // Create the recipient
      recipient = await omise.recipients.create({
        name: name,
        type: "individual",
        bank_account: {
          brand: bankAccount.brand,
          number: bankAccount.number,
          name: bankAccount.name,
        },
      });

      // Verify the recipient
      const verificationResponse = await axios.patch(
        `https://api.omise.co/recipients/${recipient.id}/verify`,
        {},
        {
          auth: {
            username: process.env.OMISE_SECRET_KEY,
            password: "",
          },
        }
      );

      // Create the payout using the recipient ID

      payout = await omise.transfers.create({
        amount: amount,
        currency: "thb",
        recipient: recipient.id,
      });

      // Mark the payout as sent
      const markAsSent = await axios.post(
        `https://api.omise.co/transfers/${payout.id}/mark_as_sent`,
        {},
        {
          auth: {
            username: process.env.OMISE_SECRET_KEY,
            password: "",
          },
        }
      );

      // Mark the payout as paid
      const markAsPaid = await axios.post(
        `https://api.omise.co/transfers/${payout.id}/mark_as_paid`,
        {},
        {
          auth: {
            username: process.env.OMISE_SECRET_KEY,
            password: "",
          },
        }
      );

      // Delete Recipient after Transfer
      const recp = await omise.recipients.destroy(recipient.id);

      res.status(200).json({ message: "Success" });
    } catch (error) {
      if (recipient) {
        try {
          await omise.recipients.destroy(recipient.id);
        } catch (cleanupError) {
          console.error("Error cleaning up recipient:", cleanupError);
        }
      }

      if (payout) {
        try {
          await omise.transfers.destroy(payout.id);
        } catch (cleanupError) {
          console.error("Error cleaning up payout:", cleanupError);
        }
      }
      res.status(500).json({ error: error.message });
    }
  } else {
    res.setHeader("Allow", ["POST"]);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
});

app.listen(port, () => {
  console.log(`Webhook server running at http://localhost:${port}`);
});
