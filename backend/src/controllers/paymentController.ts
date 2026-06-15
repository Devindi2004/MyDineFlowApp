import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { Payment } from "../models/Payment";
import { Order } from "../models/Order";
import { AuthRequest } from "../middleware/auth";
import { sendSuccess, sendError } from "../utils/response";
import { getIO } from "../sockets/socketManager";

export async function createPayment(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { orderId, paymentMethod, amount } = req.body as {
      orderId: string;
      paymentMethod: string;
      amount: number;
    };

    const order = await Order.findById(orderId);
    if (!order) {
      sendError(res, "Order not found.", 404);
      return;
    }

    const payment = await Payment.create({
      orderId,
      paymentMethod,
      amount,
      status: "pending",
    });

    // For cash/card payments, mark as paid immediately (mock flow)
    if (paymentMethod === "cash" || paymentMethod === "card") {
      payment.status = "paid";
      payment.transactionId = `TXN-${Date.now()}`;
      await payment.save();

      await Order.findByIdAndUpdate(orderId, { paymentStatus: "paid" });

      const io = getIO();
      if (io) {
        const updatedOrder = await Order.findById(orderId);
        if (updatedOrder) {
          io.to(`order:${orderId}`).emit("payment-updated", updatedOrder);
          io.to(`order:${orderId}`).emit("payment:updated", updatedOrder);
          io.to(`order:${updatedOrder.orderNumber}`).emit("payment-updated", updatedOrder);
          io.to(`order:${updatedOrder.orderNumber}`).emit("payment:updated", updatedOrder);
        }
      }
    }

    // For PayHere, return payment data for frontend redirect
    if (paymentMethod === "payhere") {
      const merchantId = process.env.PAYHERE_MERCHANT_ID ?? "1227149";
      const merchantSecret = process.env.PAYHERE_MERCHANT_SECRET ?? "";
      const orderId_str = String(order._id);
      const amount_str = amount.toFixed(2);
      const currency = "LKR";

      // Generate PayHere hash: MD5(merchant_id + order_id + amount + currency + MD5(merchant_secret).toUpperCase())
      const secretHash = merchantSecret
        ? crypto.createHash("md5").update(merchantSecret).digest("hex").toUpperCase()
        : "";
      const hashInput = `${merchantId}${orderId_str}${amount_str}${currency}${secretHash}`;
      const hash = crypto.createHash("md5").update(hashInput).digest("hex").toUpperCase();

      sendSuccess(res, {
        payment,
        payhereData: {
          merchant_id: merchantId,
          return_url: `${process.env.CLIENT_URL}/tracking/${order.orderNumber}`,
          cancel_url: `${process.env.CLIENT_URL}/checkout`,
          notify_url: `${process.env.CLIENT_URL?.replace("3000", "5000")}/api/v1/payments/payhere/notify`,
          order_id: orderId_str,
          items: order.customerName,
          currency,
          amount: amount_str,
          first_name: order.customerName.split(" ")[0] ?? "Customer",
          last_name: order.customerName.split(" ").slice(1).join(" ") || ".",
          email: "customer@dineflow.local",
          phone: order.contactNumber || "0000000000",
          address: "DineFlow Restaurant",
          city: "Colombo",
          country: "Sri Lanka",
          hash,
        },
      }, "Payment initiated.");
      return;
    }

    sendSuccess(res, { payment }, "Payment processed.");
  } catch (err) {
    next(err);
  }
}

export async function payhereNotify(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { order_id, status_code, payment_id, md5sig } = req.body as {
      order_id: string;
      status_code: string;
      payment_id: string;
      md5sig: string;
    };

    // Verify PayHere signature
    const merchantId = process.env.PAYHERE_MERCHANT_ID ?? "";
    const merchantSecret = process.env.PAYHERE_MERCHANT_SECRET ?? "";
    const amount = req.body.payhere_amount as string;
    const currency = req.body.payhere_currency as string;

    if (merchantSecret) {
      const secretHash = crypto.createHash("md5").update(merchantSecret).digest("hex").toUpperCase();
      const localSig = crypto
        .createHash("md5")
        .update(`${merchantId}${order_id}${amount}${currency}${status_code}${secretHash}`)
        .digest("hex")
        .toUpperCase();

      if (localSig !== md5sig) {
        res.status(400).send("Invalid signature");
        return;
      }
    }

    const isPaid = status_code === "2";

    await Payment.findOneAndUpdate(
      { orderId: order_id },
      {
        status: isPaid ? "paid" : "failed",
        transactionId: payment_id,
        payhereData: req.body,
      }
    );

    if (isPaid) {
      const order = await Order.findByIdAndUpdate(order_id, { paymentStatus: "paid" }, { new: true });
      const io = getIO();
      if (io && order) {
        io.to(`order:${order_id}`).emit("payment-updated", order);
        io.to(`order:${order_id}`).emit("payment:updated", order);
      }
    }

    res.status(200).send("OK");
  } catch (err) {
    next(err);
  }
}

export async function getPaymentByOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const payment = await Payment.findOne({ orderId: req.params.orderId });
    if (!payment) {
      sendError(res, "Payment not found.", 404);
      return;
    }
    sendSuccess(res, payment);
  } catch (err) {
    next(err);
  }
}
