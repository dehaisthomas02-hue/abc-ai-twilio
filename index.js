import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

dotenv.config();

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set OPENAI_API_KEY in Railway variables.");
  process.exit(1);
}

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ===== CONFIG =====
const SYSTEM_MESSAGE = `Tu es l’agent téléphonique du service à la clientèle de ABC Déneigement (Montréal).
Tu parles français québécois (fr-CA), ton est naturel, empathique, professionnel.
Tu peux: répondre aux questions, prendre des infos, proposer un rendez-vous, et transférer à un superviseur si tu n’as pas l’info.
Heures: Lun-Ven 8:30 à 17:00. Fermé samedi/dimanche.
Si on demande un rendez-vous avant 8:30 ou le weekend: refuser et proposer un autre créneau.`;

const VOICE = "alloy";
const TEMPERATURE = 0.8;

const LOG_EVENT_TYPES = [
  "error",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
  "session.updated",
];

// ===== ROUTES (DECLARE BEFORE LISTEN) =====
fastify.get("/", async () => ({ message: "Server running" }));

fastify.get("/health", async () => ({ ok: true }));

// Twilio webhook: incoming call -> return TwiML (must be 200 + XML)
fastify.all("/incoming-call", async (request, reply) => {
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const wsUrl = `wss://${host}/media-stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Chantal" language="fr-CA">Bienvenue chez ABC Déneigement. Dites-moi comment je peux vous aider.</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  reply.type("text/xml").send(twiml);
});

// WebSocket route for Twilio Media Streams
fastify.register(async (f) => {
  f.get("/media-stream", { websocket: true }, (connection, req) => {
    f.log.info("✅ Twilio WS client connected");

    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-realtime`,
      {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      }
    );

    const initializeSession = () => {
      // Keep it minimal + valid: instructions + voice + temperature.
      const sessionUpdate = {
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          instructions: SYSTEM_MESSAGE,
          voice: VOICE,
          temperature: TEMPERATURE,
          turn_detection: { type: "server_vad" },
          input_audio_format: "pcm_mulaw",
          output_audio_format: "pcm_mulaw",
        },
      };

      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;

        if (lastAssistantItem) {
          const truncateEvent = {
            type: "conversation.item.truncate",
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime,
          };
          openAiWs.send(JSON.stringify(truncateEvent));
        }

        // Clear buffered audio in Twilio
        connection.send(
          JSON.stringify({
            event: "clear",
            streamSid,
          })
        );

        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    const sendMark = () => {
      if (!streamSid) return;
      const markEvent = {
        event: "mark",
        streamSid,
        mark: { name: "responsePart" },
      };
      connection.send(JSON.stringify(markEvent));
      markQueue.push("responsePart");
    };

    openAiWs.on("open", () => {
      f.log.info("🧠 OpenAI Realtime connected");
      setTimeout(initializeSession, 100);
    });

    openAiWs.on("message", (data) => {
      let response;
      try {
        response = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (LOG_EVENT_TYPES.includes(response.type)) {
        f.log.info({ type: response.type }, "📩 OpenAI evt");
      }

      if (response.type === "response.output_audio.delta" && response.delta) {
        const audioDelta = {
          event: "media",
          streamSid,
          media: { payload: response.delta },
        };
        connection.send(JSON.stringify(audioDelta));

        if (!responseStartTimestampTwilio) {
          responseStartTimestampTwilio = latestMediaTimestamp;
        }

        if (response.item_id) lastAssistantItem = response.item_id;

        sendMark();
      }

      if (response.type === "input_audio_buffer.speech_started") {
        handleSpeechStartedEvent();
      }
    });

    openAiWs.on("error", (err) => {
      f.log.error({ err }, "❌ OpenAI WS error");
    });

    openAiWs.on("close", () => {
      f.log.info("🧠 OpenAI WS closed");
    });

    // From Twilio -> to OpenAI
    connection.on("message", (message) => {
      let data;
      try {
        data = JSON.parse(message.toString());
      } catch {
        return;
      }

      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          latestMediaTimestamp = 0;
          responseStartTimestampTwilio = null;
          f.log.info({ streamSid }, "▶️ Twilio stream start");
          break;

        case "media":
          latestMediaTimestamp = data.media.timestamp;
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              })
            );
          }
          break;

        case "mark":
          if (markQueue.length > 0) markQueue.shift();
          break;

        default:
          break;
      }
    });

    connection.on("close", () => {
      f.log.info("❌ Twilio WS disconnected");
      try {
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      } catch {}
    });
  });
});

// ===== START SERVER =====
const PORT = Number(process.env.PORT || 5050);

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`🚀 Server listening on ${PORT}`);
});


