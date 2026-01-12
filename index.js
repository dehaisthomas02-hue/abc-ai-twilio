@@ -47,134 +47,154 @@ fastify.get("/health", async () => ({ ok: true }));
 */
fastify.all("/incoming-call", async (req, reply) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const wsUrl = `wss://${host}/media-stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Chantal" language="fr-CA">Bienvenue chez ABC Déneigement. Dites-moi comment je peux vous aider.</Say>
  <Connect>
    <Stream url="${wsUrl}" track="inbound_track"/>
  </Connect>
</Response>`;

  reply.type("text/xml").send(twiml);
});

// WebSocket route: Twilio Media Streams
fastify.register(async function (fastify) {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("✅ Twilio WS client connected");

    let streamSid = null;

    // 🔒 Pour éviter conversation_already_has_active_response
    let responseLocked = false;
    let sessionReady = false;
    let pendingResponseCreate = false;

    // Compteur audio deltas (debug)
    let audioDeltas = 0;

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    const sendSessionUpdate = () => {
      // ⚠️ IMPORTANT: modalities doit être ["audio","text"] (pas juste ["audio"])
      const sessionUpdate = {
        type: "session.update",
        session: {
          type: "realtime",
          modalities: ["audio", "text"],
          instructions: SYSTEM_MESSAGE,
          voice: VOICE,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
          temperature: 0.7,
        },
      };

      console.log("🧩 Sending session.update");
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    openAiWs.on("open", () => {
      console.log("🧠 Connected to OpenAI Realtime API");
      // petit délai safe
      setTimeout(sendSessionUpdate, 100);
    });

    openAiWs.on("message", (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Log léger
      if (evt.type === "error") {
        console.log("❌ OpenAI error:", evt);
      }

      if (evt.type === "session.updated") {
        sessionReady = true;
        if (pendingResponseCreate && !responseLocked) {
          responseLocked = true;
          pendingResponseCreate = false;
          audioDeltas = 0;
          openAiWs.send(JSON.stringify({ type: "response.create" }));
          console.log("🗣️ response.create sent (after session.updated)");
        }
      }

      // ✅ Audio AI -> Twilio
      if (evt.type === "response.output_audio.delta" && evt.delta && streamSid) {
        audioDeltas++;
        const twilioMediaMsg = {
          event: "media",
          streamSid,
          media: { payload: evt.delta },
        };
        try {
          connection.send(JSON.stringify(twilioMediaMsg));
        } catch {}
      }

      // ✅ Quand OpenAI commit le buffer (VAD), on demande UNE réponse.
      // Ça évite de spam response.create sur speech_stopped / etc.
      if (evt.type === "input_audio_buffer.committed") {
        if (!responseLocked) {
        if (!sessionReady) {
          pendingResponseCreate = true;
          console.log("⏳ committed before session.updated -> queue response.create");
        } else if (!responseLocked) {
          responseLocked = true;
          audioDeltas = 0;
          openAiWs.send(JSON.stringify({ type: "response.create" }));
          console.log("🗣️ response.create sent (after committed)");
        } else {
          console.log("⚠️ committed but response already locked -> ignore");
        }
      }

      // ✅ Quand réponse terminée -> unlock
      if (evt.type === "response.done") {
        responseLocked = false;
        console.log(`✅ response.done (unlock) | audio deltas sent=${audioDeltas}`);
      }

      if (evt.type === "response.failed" || evt.type === "response.canceled") {
        responseLocked = false;
        console.log(`⚠️ ${evt.type} (unlock) | audio deltas sent=${audioDeltas}`);
      }
    });

    openAiWs.on("close", () => {
      console.log("🧠 OpenAI WS closed");
    });

    openAiWs.on("error", (e) => {
      console.log("❌ OpenAI WS error:", e?.message || e);
    });

    // Twilio -> serveur
    connection.on("message", (msg) => {
      let data;
      try {
        data = JSON.parse(msg.toString());
      } catch {
        return;
      }

      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log(`▶️ Twilio stream start sid=${streamSid}`);
        return;
      }

@@ -198,27 +218,25 @@ fastify.register(async function (fastify) {
        } catch {}
        return;
      }
    });

    connection.on("close", () => {
      console.log("❌ Twilio WS disconnected");
      try {
        openAiWs.close();
      } catch {}
    });
  });
});

// Railway
const PORT = process.env.PORT || 8080;
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server listening on ${PORT}`);
});

