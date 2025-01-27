
import { join } from 'path'
import { createBot, createProvider, createFlow, addKeyword, utils, EVENTS } from '@builderbot/bot'
import { MongoAdapter as Database } from '@builderbot/database-mongo'
import { MetaProvider as Provider } from '@builderbot/provider-meta'
import dotenv from 'dotenv'
import mongoose from 'mongoose'
import axios from 'axios'
import Grid from 'gridfs-stream'
import { Readable } from 'stream'

const PORT = process.env.PORT ?? 3000

dotenv.config();
mongoose.connect(process.env.MONGO_DB_URI)

// Configuración de GridFS
let gfs;
let gridfsBucket;

// Conexión a GridFS
const connectGridFS = async () => {
  const conn = mongoose.connection;

  conn.once('open', () => {
    console.log('Conexión abierta a MongoDB');
    gridfsBucket = new mongoose.mongo.GridFSBucket(conn.db, {
      bucketName: 'uploads',
    });
    gfs = Grid(conn.db, mongoose.mongo);
    gfs.collection('uploads');
    console.log('GridFS configurado correctamente');
  });
};

await connectGridFS();

const apoderadoSchema = new mongoose.Schema({
  dni: { type: String, required: true },
  nombre: { type: String, required: true },
  apellidoPaterno: { type: String, required: true },
  apellidoMaterno: { type: String, required: true },
  correo: { type: String, required: true },
  telefono: { type: String, required: true },
  fecha: { type: Date, required: true },
  imagen: mongoose.Schema.Types.ObjectId // Guardamos el ID de la imagen en GridFS
})

const Apoderado = mongoose.model('Apoderado', apoderadoSchema)

async function downloadFileToGridFS(urlOrigen) {
  try {
    const config = {
      method: 'get',
      responseType: 'arraybuffer', // Descargar la imagen como buffer
      url: urlOrigen,
      headers: { Authorization: `Bearer ${process.env.JWTOKEN}` },
    };

    const response = await axios(config);
    const buffer = Buffer.from(response.data);

    // Crear un stream legible desde el buffer
    const readStream = new Readable();
    readStream.push(buffer);
    readStream.push(null);

    // Guardar en GridFS
    const uploadStream = gridfsBucket.openUploadStream(`imagen_${Date.now()}.jpeg`, {
      contentType: 'image/jpeg',  // Especifica el tipo de contenido aquí
    });
    readStream.pipe(uploadStream);

    return new Promise((resolve, reject) => {
      uploadStream.on('finish', () => {
        console.log('Archivo guardado en GridFS con éxito');
        resolve(uploadStream.id); // Devuelve el ObjectId del archivo en GridFS
      });
      uploadStream.on('error', (err) => {
        console.error('Error al guardar en GridFS', err);
        reject(err);
      });
    });
  } catch (error) {
    console.error('Error al realizar la solicitud', error);
    throw error;
  }
}

const flowDNI = addKeyword(EVENTS.MEDIA).addAnswer('Finalmente, necesito una foto de tu documento de identidad (DNI). Por favor, envíala como una imagen adjunta.',
   { capture: true },
  async (ctx, { state, flowDynamic }) => {
    const url = ctx.url;

    try {
      const imageId = await downloadFileToGridFS(url);
      console.log('ID del archivo en GridFS:', imageId);

      // Guardar en la base de datos con la ruta de la imagen
      const nuevoApoderado = new Apoderado({
        dni: state.get('dni'),
        nombre: state.get('nombre'),
        apellidoPaterno: state.get('apellidoPaterno'),
        apellidoMaterno: state.get('apellidoMaterno'),
        correo: state.get('correo'),
        telefono: ctx.from,
        fecha: new Date(),
        imagen: imageId,  // Guardar el ObjectId del archivo
      });

      await nuevoApoderado.save();

      // Confirmar el registro al usuario
      await flowDynamic(
        `¡Gracias! He registrado tus datos como apoderado con la siguiente información:\n- DNI: *${state.get('dni')}*\n- Nombres: *${state.get('nombre')}*\n- Apellido Paterno: *${state.get('apellidoPaterno')}*\n- Apellido Materno: *${state.get('apellidoMaterno')}*\n- Correo: *${state.get('correo')}*\n- Teléfono: *${ctx.from}*\nLa imagen también ha sido registrada correctamente.`
      );
    } catch (error) {
      console.error("Error procesando la imagen:", error);
      await flowDynamic("Hubo un problema al procesar tu imagen. Por favor, intenta nuevamente.");
    }
  }
);

const flowApoderado = addKeyword('Hola')
  .addAction(async (ctx, { flowDynamic, endFlow }) => {
    const numero = ctx.from;

    // Verificar si el número de teléfono ya está registrado
    const usuarioExistente = await Apoderado.findOne({ telefono: numero });
    if (usuarioExistente) {
      // return await flowDynamic(`El número de teléfono *${numero}* ya está registrado. Tu usuario *${usuarioExistente.nombre}* está vinculado a este número.`);
      return endFlow(`El número de teléfono *${numero}* ya está registrado. Tu usuario *${usuarioExistente.nombre}* está vinculado a este número.`);
    }

  })
  .addAnswer(
    '¡Perfecto! Para comenzar, necesito algunos datos personales.\nPor favor, ingresa tu DNI:',
    { capture: true },
    async (ctx, { state }) => {
      await state.update({ dni: ctx.body }); // Guardar el dni en el estado
    }
  )
  .addAnswer(
    'Gracias. Ahora ingresa tu nombre:',
    { capture: true },
    async (ctx, { state }) => {
      await state.update({ nombre: ctx.body }); // Guardar el nombre en el estado
    }
  )
  .addAnswer(
    'Bien. Ahora ingresa tu apellido paterno:',
    { capture: true },
    async (ctx, { state }) => {
      await state.update({ apellidoPaterno: ctx.body }); // Guardar el apellido paterno en el estado
    }
  )
  .addAnswer(
    'Bien. Ahora ingresa apellido materno:',
    { capture: true },
    async (ctx, { state }) => {
      await state.update({ apellidoMaterno: ctx.body }); // Guardar el apellido materno en el estado
    }
  )
  .addAnswer('Perfecto, Ahora ingresa tu correo electrónico:', { capture: true }, async (ctx, { state }) => {
    await state.update({ correo: ctx.body });
  })
  .addAction(
    async (ctx, { gotoFlow }) => {
      return gotoFlow(flowDNI);
    }
  );

export default flowApoderado;

const main = async () => {
  const adapterFlow = createFlow([flowApoderado, flowDNI])
  const adapterProvider = createProvider(Provider, {
    jwtToken: process.env.JWTOKEN,
    numberId: process.env.NUMBER_ID,
    verifyToken: process.env.VERIFY_TOKEN,
    version: 'v18.0'
  })
  const adapterDB = new Database({
    dbUri: process.env.MONGO_DB_URI,
    dbName: process.env.MONGO_DB_NAME,
  })

  const { handleCtx, httpServer } = await createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB,
  })

  adapterProvider.server.post(
    '/v1/messages',
    handleCtx(async (bot, req, res) => {
      const { number, message, urlMedia } = req.body
      await bot.sendMessage(number, message, { media: urlMedia ?? null })
      return res.end('sended')
    })
  )

  adapterProvider.server.post(
    '/v1/register',
    handleCtx(async (bot, req, res) => {
      const { number, name } = req.body
      await bot.dispatch('REGISTER_FLOW', { from: number, name })
      return res.end('trigger')
    })
  )

  adapterProvider.server.post(
    '/v1/samples',
    handleCtx(async (bot, req, res) => {
      const { number, name } = req.body
      await bot.dispatch('SAMPLES', { from: number, name })
      return res.end('trigger')
    })
  )

  adapterProvider.server.post(
    '/v1/blacklist',
    handleCtx(async (bot, req, res) => {
      const { number, intent } = req.body
      if (intent === 'remove') bot.blacklist.remove(number)
      if (intent === 'add') bot.blacklist.add(number)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ status: 'ok', number, intent }))
    })
  )

  httpServer(PORT)
}

main()
