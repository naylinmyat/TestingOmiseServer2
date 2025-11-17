require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
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

app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
    // Ensure the raw body is always saved, even for Stripe's specialized webhook
    type: (req) => req.headers['content-type'] === 'application/json' || req.originalUrl === "/stripe-webhook" || req.originalUrl === "/hitpay-webhook",
  })
);

app.use(bodyParser.urlencoded({ extended: true }));

// Only parse JSON for non-webhook routes
// app.use((req, res, next) => {
//   if (req.originalUrl === "/stripe-webhook") {
//     next(); // Skip JSON parsing for Stripe webhook
//   } else {
//     bodyParser.json()(req, res, next);
//   }
// });

//Don't need in Java
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

// Function to verify charge status from OMISE
const verifyChargeStatus = async (chargeId) => {
  try {
    const charge = await omise.charges.retrieve(chargeId);
    return charge.status === "successful";
  } catch (error) {
    console.log("Error retrieving charge:", error);
    return false;
  }
};

//Need to change webhook flow in Java
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

//Need to change webhook flow in Java
app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }), // keep raw body for signature verification
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
    } catch (err) {
      console.error(`Stripe Webhook Error: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object;
      console.log("Stripe PaymentIntent successful:", paymentIntent.id);

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

//Validates the HitPay webhook payload using HMAC-SHA256.
const validateWebhook = (rawBody, receivedSignature) => {
  if (!receivedSignature || !rawBody) {
    console.error(
      "[HMAC ERROR] Validation failed: Missing signature or raw body."
    );
    return false;
  }

  // 1. Compute HMAC using SHA-256, the SALT key, and the raw JSON body
  const hmacGenerator = crypto.createHmac("sha256", process.env.HITPAY_WEBHOOK_SALT);
  const generatedSignature = hmacGenerator
    .update(rawBody, "utf-8")
    .digest("hex");

  // 2. Compare the generated signature with the signature from the header
  const isValid = generatedSignature === receivedSignature;

  if (!isValid) {
    console.error(
      `[HMAC ERROR] Validation failed. Generated: ${generatedSignature}, Received: ${receivedSignature}`
    );
  }
  return isValid;
};

//Need to change webhook flow in Java
app.post("/hitpay-webhook", async (req, res) => {
  // Get signature from header (case-insensitive)
  const hitpaySignature = req.headers["hitpay-signature"];

  // Validate HMAC using the raw body captured earlier
  if (!validateWebhook(req.rawBody, hitpaySignature)) {
    return res
      .status(400)
      .send("HMAC validation failed or signature/body missing.");
  }

  const webhookPayload = req.body;

  if (webhookPayload.status === "completed") {
    try {
      const paymentId = webhookPayload.id;
      const amount = parseFloat(webhookPayload.amount);
      const currencyId = webhookPayload.reference_number;
      const payniUserId = webhookPayload.name;

      console.log(`[WEBHOOK] Payment completed: ${paymentId}`);
      await sendToSupabase(amount, paymentId, payniUserId, false, currencyId);
    } catch (error) {
      console.error(
        "[WEBHOOK ERROR] Error processing successful payment:",
        error
      );
      return res.status(200).send("OK, but internal error occurred.");
    }
  } else {
    console.log(`[WEBHOOK] Received payment status: ${webhookPayload.status}`);
  }

  res.status(200).send("OK");
});

//API for Prompt Pay QR Generate from OMISE
app.post("/create-promptpay-charge-omise", async (req, res) => {
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

//API for PayNow QR Generate from OMISE
app.post("/create-paynow-charge-omise", async (req, res) => {
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
        currency: "sgd",
        source: {
          type: "paynow_qr",
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

//API for create customer in OMISE (to use Cards Method)
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

    res.status(200).json(customer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

//API to get customerId from OMISE by email
app.get("/get-omise-customer-id/:email", async (req, res) => {
  try {
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

//API to store card info for specific customer
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

//API to get stored cards list for specific customer
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

//API to cretae transaction by Card Method from OMISE
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

//API to change status to success for Payout in OMISE (now no need to implement),
//This is automatic Payout, don't need to request to admin !
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

//API to create receiver for Payout in OMISE (now no need to implement).
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

//API to create Payout transaction in OMISE (now no need to implement).
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

//API for Prompt Pay QR Generate from STRIPE
app.post("/create-promptpay-charge-stripe", async (req, res) => {
  try {
    const { amount, currencyId, payniUserId, email } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Valid amount is required." });
    }

    // Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: "thb",
      payment_method_types: ["promptpay"],
      metadata: {
        payniUserId,
        currencyId,
      },
    });

    // Confirm it to get QR Code
    const confirmedIntent = await stripe.paymentIntents.confirm(
      paymentIntent.id,
      {
        payment_method_data: {
          type: "promptpay",
          billing_details: {
            email: email,
          },
        },
      }
    );

    const qrDataSvg =
      confirmedIntent.next_action?.promptpay_display_qr_code?.image_url_svg;
    const qrDataPng =
      confirmedIntent.next_action?.promptpay_display_qr_code?.image_url_png;
    const data = confirmedIntent.next_action?.promptpay_display_qr_code?.data;
    const hostedInstructionsUrl =
      confirmedIntent.next_action?.promptpay_display_qr_code
        ?.hosted_instructions_url;

    res.status(200).json({
      id: confirmedIntent.id,
      qrDataSvg,
      qrDataPng,
      data,
      hostedInstructionsUrl,
      amount: confirmedIntent.amount,
    });
  } catch (error) {
    console.error("Error creating PromptPay charge:", error);
    res.status(500).json({ error: error.message });
  }
});

// ------------------------------------------------
//Stripe Card Method already have in Java !
// ------------------------------------------------

//API for Prompt Pay QR Generate from HitPay
app.post("/create-promptpay-charge-hitpay", async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    // Note: The amount is passed in the base unit (e.g., 123.00 THB), not in satang/cents.
    const { amount, payniUserId, currencyId } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: "Valid amount is required." });
    }

    // Define the request body for HitPay
    const requestBody = {
      amount: amount.toString(),
      currency: "THB",
      payment_methods: ["opn_prompt_pay"],
      generate_qr: true,
      name: payniUserId,
      reference_number: currencyId,
    };

    const response = await axios.post(process.env.HITPAY_API_URL, requestBody, {
      headers: {
        "Content-Type": "application/json",
        "X-BUSINESS-API-KEY": process.env.HITPAY_API_KEY,
        "X-Requested-With": "XMLHttpRequest",
      },
    });

    const charge = response.data;

    res.status(200).json({
      id: charge.id,
      qrCodeData: charge.qr_code_data,
      status: charge.status,
      amount: charge.amount,
    });
  } catch (error) {
    const status = error.response ? error.response.status : 500;
    const errorMessage = error.response
      ? error.response.data.message ||
        error.response.data.error ||
        "Failed to create payment request for PromptPay with HitPay."
      : error.message;

    console.error(
      "Server error during HitPay PromptPay charge creation:",
      errorMessage
    );
    res.status(status).json({ error: errorMessage });
  }
});

//API for PayNow QR Generate from HitPay
app.post("/create-paynow-charge-hitpay", async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    // Note: The amount is passed in the base unit (e.g., 123.00 SGD), not in cents.
    const { amount, payniUserId, currencyId } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: "Valid amount is required." });
    }

    // Define the request body for HitPay
    const requestBody = {
      amount: amount.toString(),
      currency: "sgd",
      payment_methods: ["paynow_online"],
      generate_qr: true,
      name: payniUserId,
      reference_number: currencyId,
    };

    const response = await axios.post(process.env.HITPAY_API_URL, requestBody, {
      headers: {
        "Content-Type": "application/json",
        "X-BUSINESS-API-KEY": process.env.HITPAY_API_KEY,
        "X-Requested-With": "XMLHttpRequest",
      },
    });

    const charge = response.data;

    res.status(200).json({
      id: charge.id,
      qrCodeData: charge.qr_code_data,
      status: charge.status,
      amount: charge.amount,
    });
  } catch (error) {
    const status = error.response ? error.response.status : 500;
    const errorMessage = error.response
      ? error.response.data.message ||
        error.response.data.error ||
        "Failed to create payment request for PayNow with HitPay."
      : error.message;

    console.error(
      "Server error during HitPay PayNow charge creation:",
      errorMessage
    );
    res.status(status).json({ error: errorMessage });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});
