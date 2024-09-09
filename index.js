import OpenAI from 'openai';
import sqlite3 from 'sqlite3';
import { WebcastPushConnection } from 'tiktok-live-connector';

// Definición de constantes globales
const MAX_FIFO_SIZE = 50;
const RETRY_DELAY = 5000; // Retraso base de 5 segundos antes de reintentar
const MAX_RETRY_COUNT = 5; // Número máximo de intentos de reintento
const QUEUE_DELAY = 10000; // Retraso de 15 segundos entre cada solicitud a la API




const OPENAI_API_KEY = '';
const OPENAI_ORG_ID = ''; // Reemplaza con tu ID de organización de OpenAI

if (!OPENAI_API_KEY) {
    console.error("API Key de OpenAI no definida.");
    process.exit(1); // Detén la ejecución si la clave API no está definida
}

// Definir la variable global de contexto
const globalContext = "Eres un asistente experto en desarrollo de software y AI. Responde de forma clara, profesional y amigable.";

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    organization: OPENAI_ORG_ID
});

const db = new sqlite3.Database('./tiktok_live.db', (err) => {
    if (err) {
        console.error('Error al conectar con la base de datos SQLite', err.message);
    } else {
        console.log('Conectado a la base de datos SQLite');
        processQueue(); // Comenzar a procesar la cola de la base de datos al iniciar
    }
});

db.run(`
    CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uniqueId TEXT,
        userId TEXT,
        comment TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

const tiktokUsername = "mastercarva";
const tiktokLiveConnection = new WebcastPushConnection(tiktokUsername);

tiktokLiveConnection.connect().then(state => {
    console.info(`Conectado a roomId ${state.roomId}`);
}).catch(err => {
    console.error('Error al conectar', err);
});

tiktokLiveConnection.on('chat', async (data) => {
    console.log(`${data.uniqueId} (userId:${data.userId}) writes: ${data.comment}`);

    db.run(`INSERT INTO comments (uniqueId, userId, comment) VALUES (?, ?, ?)`,
        [data.uniqueId, data.userId, data.comment], function (err) {
            if (err) {
                console.error('Error al guardar el comentario en la base de datos', err.message);
            } else {
                console.log(`Comentario guardado en la base de datos con ID ${this.lastID}`);
                maintainFIFOSize('comments');
            }
        });
});

function processQueue() {
    db.get(`SELECT * FROM comments ORDER BY id ASC LIMIT 1`, (err, row) => {
        if (err) {
            console.error('Error al obtener el comentario de la base de datos', err.message);
            return;
        }

        if (row) {
            console.log(`Procesando comentario uniqueId ${row.uniqueId}: "${row.comment}"`);
            sendToChatGPT(row.comment, row.uniqueId)
                .then(() => {
                    setTimeout(processQueue, QUEUE_DELAY); // Espera antes de procesar el siguiente comentario
                })
                .catch((error) => {
                    console.warn('Error al enviar a ChatGPT:', error.message);
                    setTimeout(processQueue, QUEUE_DELAY); // Reintentar después del mismo intervalo
                });
        } else {
            console.log('No hay más comentarios en la cola para procesar.');
            setTimeout(processQueue, QUEUE_DELAY); // Comprobar de nuevo después de un intervalo
        }
    });
}

async function sendToChatGPT(comment, uniqueId, retryCount = 0) {
    try {
        console.log(`Enviando solicitud a ChatGPT para el comentario uniqueId ${uniqueId}: "${comment}"`);

        // Incluir el contexto global en el mensaje enviado a ChatGPT
        const messages = [
            { role: 'system', content: globalContext }, // Agregar el contexto global al principio
            { role: 'user', content: comment }           // El comentario del usuario
        ];

        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: messages,
            max_tokens: 150,
        });

        // Asegúrate de que la respuesta de ChatGPT esté presente y tenga contenido
        if (response && response.choices && response.choices.length > 0 && response.choices[0].message && response.choices[0].message.content) {
            const gptResponse = response.choices[0].message.content;
            console.log(`Respuesta de ChatGPT para el comentario uniqueId ${uniqueId}: ${gptResponse}`);
            deleteCommentFromDatabase(uniqueId);
        } else {
            console.error('No se recibió una respuesta válida de ChatGPT o la respuesta está vacía.');
        }

    } catch (error) {
        console.error('Error al enviar a ChatGPT:', error.message);
        if (error.response) {
            console.error('Detalles del error de respuesta:', error.response.data);
        }

        if (error.response && error.response.status === 429 && retryCount < MAX_RETRY_COUNT) {
            retryCount++;
            const delay = Math.min(RETRY_DELAY * Math.pow(2, retryCount), 60000);
            console.warn(`Demasiadas solicitudes a la API de OpenAI. Reintentando en ${delay / 1000} segundos...`);
            setTimeout(() => sendToChatGPT(comment, uniqueId, retryCount), delay);
        } else if (error.response && error.response.status === 404) {
            console.error('Endpoint no encontrado. Verifica la URL del endpoint o el modelo.');
        } else {
            console.error('Error al enviar a ChatGPT:', error.message);
        }
    }
}

function deleteCommentFromDatabase(uniqueId) {
    db.run(`DELETE FROM comments WHERE uniqueId = ?`, [uniqueId], function (err) {
        if (err) {
            console.error('Error al eliminar el comentario de la base de datos', err.message);
        } else {
            console.log(`Comentario con uniqueId ${uniqueId} eliminado de la base de datos.`);
        }
    });
}

function maintainFIFOSize(tableName) {
    db.get(`SELECT COUNT(*) as count FROM ${tableName}`, (err, row) => {
        if (err) {
            console.error(`Error al obtener el número de registros de la tabla ${tableName}`, err.message);
            return;
        }

        if (row.count > MAX_FIFO_SIZE) {
            db.run(`DELETE FROM ${tableName} WHERE id = (SELECT id FROM ${tableName} ORDER BY id ASC LIMIT 1)`, (err) => {
                if (err) {
                    console.error(`Error al eliminar el registro más antiguo de la tabla ${tableName}`, err.message);
                } else {
                    console.log(`Registro más antiguo eliminado de la tabla ${tableName}`);
                }
            });
        }
    });
}

process.on('SIGINT', () => {
    console.log('Cerrando la conexión a la base de datos SQLite');
    db.close((err) => {
        if (err) {
            console.error('Error al cerrar la conexión a la base de datos', err.message);
        } else {
            console.log('Conexión a la base de datos cerrada');
        }
    });
    process.exit();
});
