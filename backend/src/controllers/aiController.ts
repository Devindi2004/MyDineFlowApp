import { Request, Response, NextFunction } from "express";
import { MenuItem } from "../models/MenuItem";
import { Order } from "../models/Order";
import { AuthRequest } from "../middleware/auth";
import { sendSuccess } from "../utils/response";

/**
 * AI Food Recommendation Engine
 * Uses OpenAI/Gemini if API key is available, otherwise falls back to
 * a smart rule-based recommendation system using order history and popularity.
 */
export async function getRecommendations(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { restaurantId, preferences, limit = 5 } = req.body as {
      restaurantId?: string;
      preferences?: string[];
      limit?: number;
    };

    const filter: Record<string, unknown> = { isAvailable: true };
    if (restaurantId) filter.restaurantId = restaurantId;

    // Try AI-powered recommendations first
    const geminiKey = process.env.GEMINI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (geminiKey || openaiKey) {
      try {
        const menuItems = await MenuItem.find(filter).limit(30).lean();
        const recommendations = await getAIRecommendations(menuItems, preferences ?? [], geminiKey, openaiKey);
        sendSuccess(res, { recommendations });
        return;
      } catch (aiError) {
        // Fall through to rule-based recommendations
        console.warn("AI recommendation failed, using fallback:", aiError);
      }
    }

    // Rule-based fallback: popular items + preference matching
    const recommendations = await getRuleBasedRecommendations(filter, preferences ?? [], Number(limit));
    sendSuccess(res, { recommendations });
  } catch (err) {
    next(err);
  }
}

async function getAIRecommendations(
  menuItems: Array<Record<string, unknown>>,
  preferences: string[],
  geminiKey?: string,
  openaiKey?: string
): Promise<Array<Record<string, unknown>>> {
  const menuSummary = menuItems
    .slice(0, 20)
    .map((item) => `${item.name} (${item.category}, LKR ${item.price}, tags: ${(item.tags as string[]).join(", ")})`)
    .join("\n");

  const prompt = `You are a restaurant recommendation AI. Based on these menu items:
${menuSummary}

Customer preferences: ${preferences.length > 0 ? preferences.join(", ") : "no specific preferences"}

Recommend the top 5 dishes with a brief reason for each. Return JSON array with fields: name, recommendationReason.`;

  if (geminiKey) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );

    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";

    // Extract JSON from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const aiRecs = JSON.parse(jsonMatch[0]) as Array<{ name: string; recommendationReason: string }>;

      // Match AI recommendations to actual menu items
      return menuItems
        .filter((item) => aiRecs.some((rec) => rec.name.toLowerCase().includes((item.name as string).toLowerCase())))
        .slice(0, 5)
        .map((item) => {
          const aiRec = aiRecs.find((rec) =>
            rec.name.toLowerCase().includes((item.name as string).toLowerCase())
          );
          return { ...item, recommendationReason: aiRec?.recommendationReason ?? "AI recommended" };
        });
    }
  }

  throw new Error("AI response parsing failed");
}

async function getRuleBasedRecommendations(
  filter: Record<string, unknown>,
  preferences: string[],
  limit: number
): Promise<Array<Record<string, unknown>>> {
  // Get top items by order count
  const popularItems = await MenuItem.find(filter)
    .sort({ orderCount: -1, rating: -1 })
    .limit(limit * 2)
    .lean();

  // Score items based on preferences
  const scored = popularItems.map((item) => {
    let score = item.orderCount as number;
    const tags = item.tags as string[];

    if (preferences.includes("vegetarian") && tags.includes("vegetarian")) score += 50;
    if (preferences.includes("vegan") && tags.includes("vegan")) score += 50;
    if (preferences.includes("gluten-free") && tags.includes("gluten-free")) score += 30;
    if (preferences.includes("high-protein") && tags.includes("high-protein")) score += 30;

    let reason = "Popular choice";
    if (tags.includes("chef-pick")) reason = "Chef's special recommendation";
    else if (tags.includes("signature")) reason = "Our signature dish";
    else if ((item.orderCount as number) > 50) reason = "Customer favourite";
    else if (tags.includes("vegan")) reason = "Great vegan option";
    else if (tags.includes("high-protein")) reason = "High protein meal";

    return { ...item, score, recommendationReason: reason };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, ...item }) => item);
}
