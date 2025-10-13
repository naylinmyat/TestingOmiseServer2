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
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
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

app.post("/omise-webhook", async (req, res) => {
  const event = req.body;

  console.log("Received event:", event);

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

app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.log(`Stripe Webhook Error: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object;

      console.log("Stripe PaymentIntent was successful:", paymentIntent.id);

      const transactionId = paymentIntent.id;
      const amount = paymentIntent.amount / 100;
      const payniUserId = paymentIntent.metadata.payniUserId;
      const currencyId = paymentIntent.metadata.currencyId;

      await sendToSupabase(
        amount,
        transactionId,
        payniUserId,
        false,
        currencyId
      );
    } else {
      console.log(`Unhandled Stripe event type: ${event.type}`);
    }

    res.json({ received: true });
  }
);

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

//---------------------------------------------------------------------------------------

/**
 * @description Creates an Omise Customer linked to Payni's user.
 * @body { email: string, description: string (e.g., "PayNI User: user123") }
 */
app.post("/create-omise-customer", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email is required." });
    }

    const customer = await omise.customers.create({
      email,
      description: `Customer for ${email}`,
    });

    // IMPORTANT: Save customer.id in your database, linked to your user.
    res.status(200).json(customer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/get-omise-customer-id/:email", async (req, res) => {
  try {
    // We expect the email in the query parameters for a GET request
    const { email } = req.params;

    if (!email) {
      return res.status(400).json({
        error:
          "Customer email is required for search (e.g., /get-omise-customer-id?email=test@example.com).",
      });
    }

    const searchResult = await omise.search.list({
      scope: "customer",
      query: email,
      // Limit to 1, as email should be unique for a customer object
      limit: 1,
    });

    const customers = searchResult.data;

    if (customers.length > 0) {
      const customerId = customers[0].id;

      return res.status(200).json({
        message: "Customer ID retrieved successfully.",
        email: email,
        customerId: customerId,
      });
    } else {
      return res.status(404).json({
        error: `Customer with email '${email}' not found. Ensure the email is correct and the customer exists.`,
      });
    }
  } catch (error) {
    console.error("Omise Search Error:", error);
    res
      .status(500)
      .json({ error: `Failed to search customer: ${error.message}` });
  }
});

/**
 * @description Attaches a new card (from a token) to an existing Omise Customer.
 * @body { omiseCustomerId: string, cardToken: string }
 */
app.post("/add-card-to-customer", async (req, res) => {
  try {
    const { omiseCustomerId, cardToken } = req.body;
    if (!omiseCustomerId || !cardToken) {
      return res
        .status(400)
        .json({ error: "omiseCustomerId and cardToken are required." });
    }

    // The update method attaches the new card token to the customer.
    const customer = await omise.customers.update(omiseCustomerId, {
      card: cardToken,
    });

    // The response will include the full customer object with the new card in the `cards` array.
    res.status(200).json(customer.cards.data.slice(-1)[0]); // Return the newly added card
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @description Lists all saved cards for a specific Omise Customer.
 * @param { omiseCusId: string }
 */
app.get("/list-customer-cards/:omiseCusId", async (req, res) => {
  try {
    const { omiseCusId } = req.params;
    if (!omiseCusId) {
      return res.status(400).json({ error: "omiseCustomerId is required." });
    }

    const cards = await omise.customers.listCards(omiseCusId);
    res.status(200).json(cards.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @description Creates a charge using a saved card for a specific customer.
 * @body { amount: number, payniUserId: string, currencyId: string, omiseCustomerId: string, cardId: string }
 */

app.post("/create-card-charge", async (req, res) => {
  try {
    const { amount, payniUserId, currencyId, omiseCustomerId, cardId } =
      req.body;

    if (!amount || amount <= 0 || !omiseCustomerId || !cardId) {
      return res.status(400).json({
        error: "Valid amount, omiseCustomerId, and cardId are required.",
      });
    }

    const charge = await omise.charges.create({
      amount, // in the smallest currency unit (e.g., 10000 for 100.00 THB)
      currency: "thb",
      customer: omiseCustomerId, // Omise Customer ID
      card: cardId, // ID of the selected card
      metadata: {
        payniUserId: payniUserId,
        currencyId: currencyId,
      },
    });

    res.status(200).json(charge);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

//---------------------------------------------------------------------------------------

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

app.post("/create-charge-stripe", async (req, res) => {
  try {
    const { amount, currencyId, payniUserId } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Valid amount is required." });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: "thb",
      payment_method_types: ["promptpay"],
      metadata: {
        payniUserId: payniUserId,
        currencyId: currencyId,
      },
    });

    const qrCodeUrl =
      paymentIntent.next_action.promptpay_display_qr_code.image_url_png;

    res.status(200).json({
      qrCodeUrl: qrCodeUrl,
    });
  } catch (error) {
    console.error("Error creating payment intent:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Webhook server running at http://localhost:${port}`);
});
