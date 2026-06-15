import { Router } from "express";
import { getRecommendations } from "../controllers/aiController";
import { authenticate } from "../middleware/auth";

const router = Router();

router.post("/recommendations", authenticate, getRecommendations);

export default router;
