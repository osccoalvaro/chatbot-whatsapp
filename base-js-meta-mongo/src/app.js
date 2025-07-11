
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

const EstudianteSchema = new mongoose.Schema({
  dni: { type: String, required: true },
  nombre: { type: String, required: true },
  apellidoPaterno: { type: String, required: true },
  apellidoMaterno: { type: String, required: true },
  tipoAdmision: { type: String, required: true },
  grado: { type: String, required: true }, // Nuevo campo para almacenar el grado elegido
  condicionMedica: { type: String }, 
  imagen: mongoose.Schema.Types.ObjectId, // Guardamos el ID de la imagen en GridFS
  imagenLibreta: mongoose.Schema.Types.ObjectId, // Nueva imagen de la libreta
  estadoAdmision: { type: String, default: "Pendiente" }, // Nuevo campo con valor por defecto
  apoderadoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Apoderado', required: true },
  pagoMatricula: { type: Boolean, default: false }
});

const Estudiante = mongoose.model('Estudiante', EstudianteSchema);

const apoderadoSchema = new mongoose.Schema({
  dni: { type: String, required: true },
  nombre: { type: String, required: true },
  apellidoPaterno: { type: String, required: true },
  apellidoMaterno: { type: String, required: true },
  correo: { type: String, required: true },
  telefono: { type: String, required: true },
  fecha: { type: Date, required: true },
  imagen: mongoose.Schema.Types.ObjectId, // Guardamos el ID de la imagen en GridFS
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

const flowYape = addKeyword(utils.setEvent('TRIGGER_YAPE'))
  .addAnswer(`_🕐 El plazo máximo para efectuar el pago es de 24 horas._`, {
    media: 'src/img/yape.png',
  })

const flowEstudianteFotoLibreta = addKeyword(EVENTS.MEDIA)
  .addAnswer(
    'Finalmente, necesito una foto de la *Libreta de notas del SIAGIE*. Por favor, envíala como una imagen adjunta.',
    { capture: true },
    async (ctx, { state, flowDynamic, fallBack }) => {
      if (ctx.type !== 'image') {
        return fallBack('El archivo enviado no es válido. Por favor, envía una imagen del *documento de identidad (DNI o CE)* del estudiante.');
      }

      const url = ctx.url;

      try {
        const imageId = await downloadFileToGridFS(url);
        console.log('ID de la libreta en GridFS:', imageId);

        // Guardar en la base de datos
        const nuevoEstudiante = new Estudiante({
          dni: state.get('dniEstudiante'),
          nombre: state.get('nombreEstudiante'),
          apellidoPaterno: state.get('apellidoPaternoEstudiante'),
          apellidoMaterno: state.get('apellidoMaternoEstudiante'),
          grado: state.get('grado'), // Agregar el grado almacenado
          condicionMedica: state.get('condicionMedica'),
          tipoAdmision: state.get('tipoAdmision'),
          apoderadoId: state.get('apoderadoId'), // Asociar con el apoderado
          fecha: new Date(),
          imagen: state.get('imagenDNI'),
          imagenLibreta: imageId, // Guardar el ObjectId del archivo
        });

        await nuevoEstudiante.save();

        await flowDynamic(
          `¡Gracias! He registrado los datos del estudiante con la siguiente información:\n- Admisión: *${state.get('tipoAdmision')}*\n- Grado: *${state.get('grado')}*\n- N° documento: *${state.get('dniEstudiante')}*\n- Nombre: *${state.get('nombreEstudiante')}*\n- Apellido Paterno: *${state.get('apellidoPaternoEstudiante')}*\n- Apellido Materno: *${state.get('apellidoMaternoEstudiante')}*\n- Condición Médica: *${state.get('condicionMedicaFlag')}*\nLos documentos también han sido registrados correctamente. 🪪📃`
        );
        await flowDynamic(
          `En un plazo máximo de *24 horas* nos comunicaremos contigo para informarte sobre el *estado de admisión del estudiante*. 🕐`
        );

      } catch (error) {
        console.error("Error procesando la imagen:", error);
      }
    }
  );

const flowEstudianteFotoDNI = addKeyword(EVENTS.MEDIA)
  .addAnswer(
    '6. Ahora necesito una foto del *documento de identidad (DNI o CE)* del estudiante. Por favor, envíala como una imagen adjunta.',
    { capture: true },
    async (ctx, { state, flowDynamic, fallBack, gotoFlow }) => {
      if (ctx.type !== 'image') {
        return fallBack('El archivo enviado no es válido. Por favor, envía una imagen del *documento de identidad (DNI o CE)* del estudiante.');
      }

      const url = ctx.url;

      try {
        const imageId = await downloadFileToGridFS(url);
        console.log('ID del DNI en GridFS:', imageId);
        state.update({ imagenDNI: imageId });

        await flowDynamic('Documento registrado. ✅');

        const tipoAdmision = state.get('tipoAdmision');

        if (tipoAdmision === 'Traslado') {
          return gotoFlow(flowEstudianteFotoLibreta);
        } else {
          // Si es "Nuevo", guardar directamente en la base de datos
          const nuevoEstudiante = new Estudiante({
            dni: state.get('dniEstudiante'),
            nombre: state.get('nombreEstudiante'),
            apellidoPaterno: state.get('apellidoPaternoEstudiante'),
            apellidoMaterno: state.get('apellidoMaternoEstudiante'),
            grado: state.get('grado'),
            condicionMedica: state.get('condicionMedica'),
            tipoAdmision: tipoAdmision,
            apoderadoId: state.get('apoderadoId'),
            fecha: new Date(),
            imagen: imageId,
            imagenLibreta: null, // No hay libreta si es nuevo
          });

          await nuevoEstudiante.save();

          await flowDynamic(
            `¡Gracias! He registrado los datos del estudiante con la siguiente información:\n- Admisión: *${state.get('tipoAdmision')}*\n- Grado: *${state.get('grado')}*\n- N° documento: *${state.get('dniEstudiante')}*\n- Nombre: *${state.get('nombreEstudiante')}*\n- Apellido Paterno: *${state.get('apellidoPaternoEstudiante')}*\n- Apellido Materno: *${state.get('apellidoMaternoEstudiante')}*\n- Condición Médica: *${state.get('condicionMedicaFlag')}*\nEl documento también ha sido registrado correctamente. 🪪`
          );
          await flowDynamic(
            `En un plazo máximo de *24 horas* nos comunicaremos contigo para informarte sobre el *estado de admisión del estudiante*. 🕐`
          );
        }

      } catch (error) {
        console.error("Error procesando la imagen:", error);
      }
    }
  );

const flowCondicionMedica = addKeyword(EVENTS.ACTION)
  .addAnswer(
    'Por favor describa la *condición*:',
    { capture: true },
    async (ctx, { state }) => {
      await state.update({ condicionMedica: ctx.body });
    }
  )
  .addAction(async (ctx, { gotoFlow }) => {
    return gotoFlow(flowEstudianteFotoDNI);
  });

const flowEstudiante = addKeyword(EVENTS.ACTION)
  .addAnswer('Vamos a continuar con los datos del estudiante para completar el *Proceso de Admisión*. 😊')
  .addAnswer(
    '1. Ingresa el número de *documento de identidad (DNI o CE)* del estudiante:',
    { capture: true },
    async (ctx, { state, fallBack }) => {
      const dni = ctx.body;
      if (!/^\d+$/.test(dni)) {
        return fallBack('El DNI ingresado no es válido. Por favor, ingresa solo números.');
      }
      await state.update({ dniEstudiante: dni });
    }
  )
  .addAnswer(
    '2. Ingresa el *nombre* del estudiante:',
    { capture: true },
    async (ctx, { state }) => {
      await state.update({ nombreEstudiante: ctx.body });
    }
  )
  .addAnswer(
    '3. Ingresa el *apellido paterno* del estudiante:',
    { capture: true },
    async (ctx, { state }) => {
      await state.update({ apellidoPaternoEstudiante: ctx.body });
    }
  )
  .addAnswer(
    '4. Ingresa el *apellido materno* del estudiante:',
    { capture: true },
    async (ctx, { state }) => {
      await state.update({ apellidoMaternoEstudiante: ctx.body });
    }
  )
  .addAnswer('5. ¿El estudiante presenta alguna *condición médica* o *necesidad especial*?',
    {
      delay: 2000,
      buttons: [
        { body: 'Si' },
        { body: 'No' },
      ]
    }
  )
  .addAction({ capture: true },
    async (ctx, { gotoFlow, state }) => {
      if (ctx.body == 'Si') {
        await state.update({ condicionMedicaFlag: 'Sí' });
        return gotoFlow(flowCondicionMedica)
      } else if (ctx.body == 'No') {
        await state.update({ condicionMedicaFlag: 'No', condicionMedica: '' });
        return gotoFlow(flowEstudianteFotoDNI)
      }
    }
  ); 

const flowApoderadoFotoDNI = addKeyword(EVENTS.MEDIA).addAnswer('6. Finalmente, necesito una foto de tu *documento de identidad (DNI o CE)*. Por favor, envíala como una imagen adjunta.',
  { capture: true },
  async (ctx, { state, flowDynamic, fallBack, gotoFlow }) => {
    // Verificar si el tipo de mensaje es una imagen
    if (ctx.type !== 'image') {
      return fallBack('El archivo enviado no es válido. Por favor, envía una imagen del documento de identidad (DNI).');
    }

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
        `¡Gracias! He registrado tus datos como apoderado con la siguiente información:\n- N° documento: *${state.get('dni')}*\n- Nombre: *${state.get('nombre')}*\n- Apellido Paterno: *${state.get('apellidoPaterno')}*\n- Apellido Materno: *${state.get('apellidoMaterno')}*\n- Correo: *${state.get('correo')}*\n- Teléfono: *${ctx.from}*\nEl documento también ha sido registrado correctamente. 🪪`
      );
      // Guardar el ID del apoderado en el estado para asociarlo al estudiante
      await state.update({ apoderadoId: nuevoApoderado._id });

      return gotoFlow(flowEstudiante);
    } catch (error) {
      console.error("Error procesando la imagen:", error);
    }
  }
)

const flowApoderado = addKeyword(EVENTS.ACTION)
  .addAnswer(
    '¡Perfecto! Para comenzar, necesito algunos datos personales.\n1. Ingresa tu número de *documento de identidad (DNI o CE)*:',
    { capture: true },
    async (ctx, { state, fallBack }) => {
      const dni = ctx.body;

      // Validar que solo contenga números
      if (!/^\d+$/.test(dni)) {
        return fallBack('El DNI ingresado no es válido. Por favor, ingresa solo números.');
      }

      // Guardar el DNI en el estado
      await state.update({ dni });
    }
  )
  .addAnswer(
    '2. Ingresa tu *nombre*:',
    { capture: true },
    async (ctx, { state }) => {
      await state.update({ nombre: ctx.body }); // Guardar el nombre en el estado
    }
  )
  .addAnswer(
    '3. Ingresa tu *apellido paterno*:',
    { capture: true },
    async (ctx, { state }) => {
      await state.update({ apellidoPaterno: ctx.body }); // Guardar el apellido paterno en el estado
    }
  )
  .addAnswer(
    '4. Ingresa tu *apellido materno*:',
    { capture: true },
    async (ctx, { state }) => {
      await state.update({ apellidoMaterno: ctx.body }); // Guardar el apellido materno en el estado
    }
  )
  .addAnswer(
    '5. Ingresa tu *correo* electrónico:',
    { capture: true },
    async (ctx, { state, fallBack }) => {
      const correo = ctx.body;

      // Validar formato de correo electrónico
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
        return fallBack('El correo electrónico ingresado no es válido. Por favor, ingresa un correo válido.');
      }

      // Guardar el correo en el estado
      await state.update({ correo });
    }
  )
  .addAction(
    async (ctx, { gotoFlow }) => {
      return gotoFlow(flowApoderadoFotoDNI);
    }
  );
export default flowApoderado;

const flowApoderadoLegal = addKeyword(EVENTS.ACTION)
  .addAnswer('¿Eres el *apoderado legal* del estudiante?',
    {
      delay: 2000,
      buttons: [
        { body: 'Si' },
        { body: 'No' }
      ]
    })
  .addAction({ capture: true },
    async (ctx, { gotoFlow }) => {
      if (ctx.body == 'Si') {
        return gotoFlow(flowApoderado)
      } else if (ctx.body == 'No') {
        await flowDynamic('Solo el *apoderado legal* del estudiante puede iniciar el Proceso de Admisión. 😔');
        return gotoFlow(flowPrincipal)
      }
    }
  ) 

const flowValidarApoderado = addKeyword(EVENTS.ACTION)
  .addAction(async (ctx, { flowDynamic, endFlow, gotoFlow, state }) => {
    const numero = ctx.from;

    // Verificar si el número de teléfono ya está registrado
    const usuarioExistente = await Apoderado.findOne({ telefono: numero });
    if (usuarioExistente) {
      // return await flowDynamic(`El número de teléfono *${numero}* ya está registrado. Tu usuario *${usuarioExistente.nombre}* está vinculado a este número.`);
      //await flowDynamic(`¡Perfecto, *${usuarioExistente.nombre}*!\nYa tenemos registrados tus datos personales y número de teléfono 📱${numero} como apoderado.`);
      await flowDynamic(`¡Perfecto, *${usuarioExistente.nombre}*!\nYa tenemos registrado tus datos personales como *apoderado*, asociado al número de teléfono 📱*${numero}*.`);
      //Guardar el ID del apoderado en el estado para asociarlo al estudiante
      await state.update({ apoderadoId: usuarioExistente._id });

      return gotoFlow(flowEstudiante)
    }
    return gotoFlow(flowApoderadoLegal)
  })

const flowAdmisionTraslado = addKeyword(EVENTS.ACTION)
  .addAnswer(['Antes de iniciar el *Proceso de Admisión*, asegúrate de tener a la mano los siguientes documentos:\n- *DNI del apoderado*\n- *DNI del estudiante*\n- *Libreta de notas del SIAGIE* \n',
    '_Estos documentos son necesarios para completar el registro._'])
  .addAnswer('¿Deseas iniciar el *Proceso de Admisión*?',
    {
      delay: 2000,
      buttons: [
        { body: 'Si' },
        { body: 'No' },
      ]
    })
  .addAction({ capture: true },
    async (ctx, { gotoFlow }) => {
      if (ctx.body == 'Si') {
        return gotoFlow(flowValidarApoderado)
      } else if (ctx.body == 'No') {
        return gotoFlow(flowPrincipal)
      }
    }
  )

const flowAdmisionNuevo = addKeyword(EVENTS.ACTION)
  .addAnswer(['Antes de iniciar el *Proceso de Admisión*, asegúrate de tener a la mano los siguientes documentos:\n- *DNI del apoderado*\n- *DNI del estudiante*\n',
    '_Estos documentos son necesarios para completar el registro._'])
  .addAnswer('¿Deseas iniciar el *Proceso de Admisión*?',
    {
      delay: 2000,
      buttons: [
        { body: 'Si' },
        { body: 'No' },
      ]
    })
  .addAction({ capture: true },
    async (ctx, { gotoFlow }) => {
      if (ctx.body == 'Si') {
        return gotoFlow(flowValidarApoderado)
      } else if (ctx.body == 'No') {
        return gotoFlow(flowPrincipal)
      }
    }
  )  

const flowVacante = addKeyword(['grado_1_id', 'grado_2_id', 'grado_3_id', 'grado_4_id', 'grado_5_id', 'grado_6_id', 'grado_7_id', 'grado_8_id', 'grado_9_id', 'grado_10_id', 'grado_11_id', 'grado_12_id', 'grado_13_id', 'grado_14_id'])
  .addAction(async (ctx, { flowDynamic, gotoFlow, state }) => {
    try {
      // Petición a la API para obtener los datos
      const response = await axios.get('http://localhost:5000/api/grados');
      const grados = response.data;

      // Mapeo de IDs a los datos de la API con nombre y nivel
      const selectedOption = {
        "grado_1_id": { nombre: "3 Años", nivel: "Inicial" },
        "grado_2_id": { nombre: "4 Años", nivel: "Inicial" },
        "grado_3_id": { nombre: "5 Años", nivel: "Inicial" },
        "grado_4_id": { nombre: "1° Grado", nivel: "Primaria" },
        "grado_5_id": { nombre: "2° Grado", nivel: "Primaria" },
        "grado_6_id": { nombre: "3° Grado", nivel: "Primaria" },
        "grado_7_id": { nombre: "4° Grado", nivel: "Primaria" },
        "grado_8_id": { nombre: "5° Grado", nivel: "Primaria" },
        "grado_9_id": { nombre: "6° Grado", nivel: "Primaria" },
        "grado_10_id": { nombre: "1° Grado", nivel: "Secundaria" },
        "grado_11_id": { nombre: "2° Grado", nivel: "Secundaria" },
        "grado_12_id": { nombre: "3° Grado", nivel: "Secundaria" },
        "grado_13_id": { nombre: "4° Grado", nivel: "Secundaria" },
        "grado_14_id": { nombre: "5° Grado", nivel: "Secundaria" }
      };

      // Obtiene el grado seleccionado por el usuario
      const selectedGrado = selectedOption[ctx.body];

      // Busca el grado en los datos obtenidos de la API considerando nombre y nivel
      const gradoInfo = grados.find(g => g.nombre === selectedGrado.nombre && g.nivel === selectedGrado.nivel);

      // Extrae la cantidad de vacantes del grado seleccionado
      const vacante = gradoInfo.vacante;
      await state.update({ grado: `${selectedGrado.nombre} ${selectedGrado.nivel}` });

      if (vacante > 0) {
        await flowDynamic(`Muy bien, contamos con vacante disponible en *${selectedGrado.nombre} ${selectedGrado.nivel}*. 🤗`);

        const tipoAdmision = state.get('tipoAdmision');
        
        if (tipoAdmision === 'Traslado') {
          return gotoFlow(flowAdmisionTraslado);
        } else {
          return gotoFlow(flowAdmisionNuevo);
        }

      } else {
        return await flowDynamic(`Lo siento, no contamos con vacante disponible en *${selectedGrado.nombre} ${selectedGrado.nivel}*. 😔`);
      }
    } catch (error) {
      console.error('Error al obtener los datos de la API:', error);
      return await flowDynamic('Ocurrió un error al verificar la disponibilidad de vacantes. 😔');
    }
  });

const flowSecundariaTraslado = addKeyword("Secundaria").addAction(
  async (ctx, { provider }) => {
    const list = {
      body: {
        text: "Por favor, elige un *grado* para poder continuar. 😊",
      },
      action: {
        button: "Opciones",
        sections: [
          {
            rows: [
              { id: "grado_10_id", title: "1° grado", description: "SECUNDARIA" },
              { id: "grado_11_id", title: "2° grado", description: "SECUNDARIA" },
              { id: "grado_12_id", title: "3° grado", description: "SECUNDARIA" },
              { id: "grado_13_id", title: "4° grado", description: "SECUNDARIA" },
              { id: "grado_14_id", title: "5° grado", description: "SECUNDARIA" }
            ],
          },
        ],
      },
    };
    // Enviar la lista de grados al usuario
    await provider.sendList(ctx.from, list);
  },
  [flowVacante]
);

const flowPrimariaTraslado = addKeyword("Primaria").addAction(
  async (ctx, { provider }) => {
    const list = {
      body: {
        text: "Por favor, elige un *grado* para poder continuar. 😊",
      },
      action: {
        button: "Opciones",
        sections: [
          {
            rows: [
              { id: "grado_4_id", title: "1° grado", description: "PRIMARIA" },
              { id: "grado_5_id", title: "2° grado", description: "PRIMARIA" },
              { id: "grado_6_id", title: "3° grado", description: "PRIMARIA" },
              { id: "grado_7_id", title: "4° grado", description: "PRIMARIA" },
              { id: "grado_8_id", title: "5° grado", description: "PRIMARIA" },
              { id: "grado_9_id", title: "6° grado", description: "PRIMARIA" }
            ],
          },
        ],
      },
    };
    // Enviar la lista de grados al usuario
    await provider.sendList(ctx.from, list);
  },
  [flowVacante]
);

const flowInicialTraslado = addKeyword("Inicial").addAction(
  async (ctx, { provider }) => {
    const list = {
      body: {
        text: "Por favor, elige un *grado* para poder continuar. 😊",
      },
      action: {
        button: "Opciones",
        sections: [
          {
            rows: [
              { id: "grado_1_id", title: "3 Años", description: "INICIAL" },
              { id: "grado_2_id", title: "4 Años", description: "INICIAL" },
              { id: "grado_3_id", title: "5 Años", description: "INICIAL" }
            ],
          },
        ],
      },
    };
    // Enviar la lista de grados al usuario
    await provider.sendList(ctx.from, list);
  },
  [flowVacante]
);

const flowNivelTraslado = addKeyword("2. Traslado 🚌")
.addAnswer('Elige un *nivel* para poder continuar. 🤗',
  {
    delay: 2000,
    buttons: [
      { body: 'Inicial' },
      { body: 'Primaria' },
      { body: 'Secundaria' }
    ]
  },
  async (ctx, { state }) => {
    await state.update({ tipoAdmision: 'Traslado' });
  },
  [flowInicialTraslado, flowPrimariaTraslado, flowSecundariaTraslado]
)

const flowGradoNuevo = addKeyword("1. Nuevo 👦🏻").addAction(
  async (ctx, { provider, state }) => {
    await state.update({ tipoAdmision: 'Nuevo' }); // <-- Guardamos en el state
    const list = {
      body: {
        text: "Por favor, elige un *grado* para poder continuar. 😊",
      },
      action: {
        button: "Opciones",
        sections: [
          {
            rows: [
              { id: "grado_1_id", title: "3 años", description: "INICIAL" },
              { id: "grado_2_id", title: "4 años", description: "INICIAL" },
              { id: "grado_3_id", title: "5 años", description: "INICIAL" },
              { id: "grado_4_id", title: "1° grado", description: "PRIMARIA" }
            ],
          },
        ],
      },
    };
    // Enviar la lista de grados al usuario
    await provider.sendList(ctx.from, list);
  },
  [flowVacante]
);

const flowTipoAdmision = addKeyword('Admisión 2025')
  .addAnswer('Elige un *tipo de admisión* para poder continuar:')
  .addAnswer(['*1. Nuevo estudiante* 👦🏻\nDirigido a estudiantes de inicial o 1° primaria que estudiarán por primera vez.\n',
    '*2. Traslado estudiante* 🚌\nDirigido a estudiantes que pertenecen a otra institución e ingresarán a nuestro colegio.',
  //'👨‍🎓 *Actual estudiante* si alguno de tus hijos ya estudia en nuestro colegio.'
  ],
    {
      delay: 2000,
      buttons: [
        { body: '1. Nuevo 👦🏻' },
        { body: '2. Traslado 🚌' },
      //{ body: 'Actual estudiante 👨‍🎓' }
      ]
    },
    null,
    [flowGradoNuevo, flowNivelTraslado]
  )

const flowPrincipal = addKeyword(EVENTS.WELCOME)
  .addAction(async (ctx, { flowDynamic }) => {
    const name = ctx.pushName; // ctx.pushName || 'amigo'; Por si no tiene nombre
    await flowDynamic(`👋 ¡Hola ${name}! Bienvenido al *Colegio Montessori*. Soy María, tu asesora virtual. 🤖`);
  })
  //.addAnswer('Puedes seleccionar una de las *siguientes opciones*. O también, *escribeme tu consulta*. ✍',
  .addAnswer('Puedes seleccionar una de las *siguientes opciones*:',
    {
      delay: 2000,
      buttons: [
        { body: 'Plan Educativo' },
        { body: 'Admisión 2025' },
        //{ body: 'Contactar Asesor' }
      ]
    },
    null,
    [flowTipoAdmision]
  )

const main = async () => {
  const adapterFlow = createFlow([flowPrincipal, flowTipoAdmision, flowGradoNuevo, flowNivelTraslado, flowInicialTraslado, flowPrimariaTraslado, flowSecundariaTraslado, flowVacante, flowAdmisionNuevo, flowAdmisionTraslado, flowValidarApoderado, flowApoderadoLegal, flowApoderado, flowApoderadoFotoDNI, flowEstudiante, flowCondicionMedica, flowEstudianteFotoDNI, flowEstudianteFotoLibreta, flowYape])
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

  adapterProvider.server.post(
  '/v1/start-flow',
  handleCtx(async (bot, req, res) => {
    const { number, flow } = req.body
    await bot.dispatch(flow, { from: number })

    return res.end('flow started')
  })
)

  httpServer(PORT)
}

main()
