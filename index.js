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

// ===== Constants (repo-style) =====
const SYSTEM_MESSAGE = `Tu es l’agent téléphonique du service à la clientèle de ABC Déneigement (Montréal).
Tu parles français québécois (fr-CA), ton est naturel, empathique, professionnel.
Tu peux: répondre aux questions, prendre des infos, proposer un rendez-vous, et transférer à un superviseur si tu n’as pas l’info.
Heures: Lun-Ven 8:30 à 17:00. Fermé samedi/dimanche.
Si on demande un rendez-vous avant 8:30 ou le weekend: refuser et proposer un autre créneau.`;

const VOICE = "alloy";
const TEMPERATURE = 0.8;

const LOG_EVENT_TYPES = [
  "error",
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
  "session.updated",
  "response.created"
];

const SHOW_TIMING_MATH = false;

// ===== Health / Root =====
fastify.get("/", async () => ({ message: "Twilio Media Stream Server is running!" }));
fastify.get("/health", async () => ({ ok: true }));

// ===== Incoming call (TwiML) =====
fastify.all("/incoming-call", async (request, reply) => {
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const wsUrl = `wss://${host}/media-stream`;

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Chantal" language="fr-CA">Bienvenue chez ABC Déneigement. Dites-moi comment je peux vous aider.</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// ===== WebSocket route for Twilio media stream =====
fastify.register(async (f) => {
  f.get("/media-stream", { websocket: true }, (connection, req) => {
    f.log.info("✅ Twilio WS client connected");

    // Connection-specific state (repo-style)
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // IMPORTANT: lock to prevent "conversation already has active response"
    let responseInProgress = false;

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-realtime`,
      {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
      }
    );

    // Control initial session with OpenAI
    const initializeSession = () => {
      // Minimal VALID session.update + correct formats for Twilio (g711_ulaw)
      const sessionUpdate = {
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          instructions: SYSTEM_MESSAGE,
          voice: VOICE,
          temperature: TEMPERATURE,
          turn_detection: { type: "server_vad" },

          // Twilio Media Streams audio codec
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw"
        }
      };

      f.log.info({ sessionUpdate: { ...sessionUpdate, session: { ...sessionUpdate.session, instructions: "[omitted]" } } }, "🧩 Sending session.update");
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    // Handle interruption when caller speaks while AI speaking
    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        if (SHOW_TIMING_MATH) f.log.info(`elapsed = ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);

        if (lastAssistantItem) {
          const truncateEvent = {
            type: "conversation.item.truncate",
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime
          };
          openAiWs.send(JSON.stringify(truncateEvent));
        }

        connection.send(JSON.stringify({ event: "clear", streamSid }));

        // Reset playback tracking
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;

        // Cancel any in-progress response
        if (responseInProgress) {
          openAiWs.send(JSON.stringify({ type: "response.cancel" }));
          responseInProgress = false;
        }
      }
    };

    // Send mark messages so we know when playback finished
    const sendMark = () => {
      if (!streamSid) return;
      const markEvent = { event: "mark", streamSid, mark: { name: "responsePart" } };
      connection.send(JSON.stringify(markEvent));
      markQueue.push("responsePart");
    };

    // OpenAI WS open
    openAiWs.on("open", () => {
      f.log.info("🧠 Connected to OpenAI Realtime API");
      setTimeout(initializeSession, 100);
    });

    // OpenAI WS messages
    openAiWs.on("message", (raw) => {
      let response;
      try {
        response = JSON.parse(raw.toString());
      } catch (err) {
        f.log.error({ err }, "❌ Failed parsing OpenAI message");
        return;
      }

      if (LOG_EVENT_TYPES.includes(response.type)) {
        f.log.info({ type: response.type }, "📩 OpenAI evt");
      }

      if (response.type === "response.created") {
        responseInProgress = true;
      }

      if (response.type === "response.done") {
        responseInProgress = false;
      }

      // ✅ CRUCIAL: When server_vad commits user audio, we must request a response
      if (response.type === "input_audio_buffer.committed") {
        if (!responseInProgress) {
          openAiWs.send(JSON.stringify({ type: "response.create" }));
          responseInProgress = true; // lock immediately
          f.log.info("🗣️ response.create sent");
        } else {
          f.log.info("⚠️ response already in progress, skip response.create");
        }
      }

      // Stream AI audio back to Twilio
      if (response.type === "response.output_audio.delta" && response.delta) {
        const audioDelta = {
          event: "media",
          streamSid,
          media: { payload: response.delta }
        };
        connection.send(JSON.stringify(audioDelta));

        // start timing at first delta
        if (!responseStartTimestampTwilio) {
          responseStartTimestampTwilio = latestMediaTimestamp;
        }

        if (response.item_id) lastAssistantItem = response.item_id;

        sendMark();
      }

      // If caller starts speaking, truncate/cancel AI
      if (response.type === "input_audio_buffer.speech_started") {
        handleSpeechStartedEvent();
      }

      if (response.type === "error") {
        f.log.error({ response }, "OpenAI error");
        // unlock to allow next attempt
        responseInProgress = false;
      }
    });

    // OpenAI errors/close
    openAiWs.on("error", (err) => {
      f.log.error({ err }, "❌ OpenAI WS error");
    });

    openAiWs.on("close", () => {
      f.log.info("🧠 OpenAI WS closed");
    });

    // Twilio -> server messages
    connection.on("message", (message) => {
      let data;
      try {
        data = JSON.parse(message.toString());
      } catch (err) {
        f.log.error({ err }, "❌ Error parsing Twilio WS message");
        return;
      }

      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          f.log.info({ streamSid }, "▶️ Twilio stream start");
          responseStartTimestampTwilio = null;
          latestMediaTimestamp = 0;
          markQueue = [];
          lastAssistantItem = null;
          responseInProgress = false;
          break;

        case "media":
          latestMediaTimestamp = data.media.timestamp;

          // Send inbound audio chunks to OpenAI
          if (openAiWs.readyState === WebSocket.OPEN) {
            const audioAppend = {
              type: "input_audio_buffer.append",
              audio: data.media.payload
            };
            openAiWs.send(JSON.stringify(audioAppend));
          }
          break;

        case "mark":
          if (markQueue.length > 0) markQueue.shift();
          break;

        default:
          // ignore
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

// ===== Start server (must be last) =====
const PORT = Number(process.env.PORT || 5050);

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`🚀 Server listening on ${PORT}`);
});



