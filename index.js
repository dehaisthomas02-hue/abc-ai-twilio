@@ -66,51 +66,50 @@ fastify.register(async function (fastify) {
    console.log("✅ Twilio WS client connected");

    let streamSid = null;

    // 🔒 Pour éviter conversation_already_has_active_response
    let responseLocked = false;

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
@@ -131,50 +130,55 @@ fastify.register(async function (fastify) {
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

@@ -199,26 +203,25 @@ fastify.register(async function (fastify) {
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




