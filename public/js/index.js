import { db } from "./firebase-config.js";
import { collection, getDocs, addDoc, query, where, doc, setDoc } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const video = document.getElementById('camara');
const mensaje = document.getElementById('mensajeScanner');

const toleranciaReconocimiento = 0.45; // Ajusta este valor para ser más o menos estricto en el reconocimiento facial

let rostrosConocidos = []; 
let mapaCorreos = {}; 
let basesDeDatosGrupos = {}; 
let diccionarioUsuarios = {}; // NUEVO: Guarda objeto completo {correo: {nombre, grupos}}
let comparadorFacial = null; 
let opcionesGrupos = []; // NUEVO: Guardará la lista de grupos para el buscador

// Inicializar EmailJS con la Public Key
emailjs.init("PVySdKrUGNpDOYaCs");

async function inicializarEscaner() {
    try {
        mensaje.innerText = "1/3 Cargando IA...";
        await faceapi.nets.ssdMobilenetv1.loadFromUri('./models');
        await faceapi.nets.faceLandmark68Net.loadFromUri('./models');
        await faceapi.nets.faceRecognitionNet.loadFromUri('./models');
        
        mensaje.innerText = "2/3 Encendiendo cámara...";
        await encenderCamara(); 

        mensaje.innerText = "3/3 Sincronizando Base de Datos...";
        await descargarDatosFirebase();
        await cargarReunionesAutocompletado();
        
    } catch (error) {
        console.error(error);
        mensaje.innerText = "Error crítico al inicializar.";
        mensaje.style.color = "red";
    }
    iniciarReconocimiento();
}

async function encenderCamara() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
    } catch (error) {
        alert("⛔ No se pudo acceder a la cámara.");
        throw error; 
    }
}

async function descargarDatosFirebase() {
    try {
        rostrosConocidos = []; mapaCorreos = {}; basesDeDatosGrupos = {}; diccionarioUsuarios = {};
        const querySnapshot = await getDocs(collection(db, "Users"));
        
        querySnapshot.forEach((doc) => {
            const datos = doc.data();
            if (!datos.nombreCompleto || !datos.descriptor) return; 

            const nombre = String(datos.nombreCompleto);
            const correo = doc.id;
            mapaCorreos[nombre] = correo;
            
            const gruposDeLaPersona = datos.grupos || ["Sin Grupo"];
            
            // Llenamos el diccionario maestro para usarlo en el reporte final
            diccionarioUsuarios[correo] = { nombre: nombre, grupos: gruposDeLaPersona };
    
            gruposDeLaPersona.forEach(nombreGrupo => {
                if (!basesDeDatosGrupos[nombreGrupo]) basesDeDatosGrupos[nombreGrupo] = [];
                basesDeDatosGrupos[nombreGrupo].push(correo);
            });

            const rostroEtiquetado = new faceapi.LabeledFaceDescriptors(nombre, [new Float32Array(datos.descriptor)]);
            rostrosConocidos.push(rostroEtiquetado);
        });

        comparadorFacial = new faceapi.FaceMatcher(rostrosConocidos, toleranciaReconocimiento);
        
        // Llenar el nuevo buscador inteligente de grupos
        opcionesGrupos = [{ valor: "todos", texto: "Todos los registrados" }];
        for (const grupo in basesDeDatosGrupos) {
            opcionesGrupos.push({
                valor: grupo,
                texto: `${grupo} (${basesDeDatosGrupos[grupo].length} personas)`
            });
        }
        
        // Configurar los valores por defecto
        // Dejamos los valores en blanco para evitar envíos masivos por accidente
        document.getElementById('buscadorGruposModal').value = "";
        document.getElementById('selectGrupo').value = "";
        document.getElementById('buscadorGruposModal').placeholder = "Escribe para buscar...";

        mensaje.innerText = "Sistema listo.";
        mensaje.style.color = "lightgreen";
    } catch (error) {
        console.error(error);
    }
}

async function cargarReunionesAutocompletado() {
    const reunionesSnapshot = await getDocs(collection(db, "Reuniones"));
    const datalistReuniones = document.getElementById('listaReuniones');
    datalistReuniones.innerHTML = "";
    reunionesSnapshot.forEach(doc => {
        datalistReuniones.innerHTML += `<option value="${doc.id}"></option>`;
    });
}

let ultimoRegistroUsuario = {}; 
async function registrarAcceso(nombrePersona) {
    const tiempoActual = Date.now(); 
    if (ultimoRegistroUsuario[nombrePersona] && (tiempoActual - ultimoRegistroUsuario[nombrePersona] < 60000)) return; 

    ultimoRegistroUsuario[nombrePersona] = tiempoActual;
    const correoDeLaPersona = mapaCorreos[nombrePersona] || "Desconocido";

    try {
        const fechaActual = new Date();
        await addDoc(collection(db, "Historial"), {
            nombre: nombrePersona,
            correo: correoDeLaPersona,
            fecha: fechaActual.toLocaleDateString(), 
            hora: fechaActual.toLocaleTimeString(),  
            timestamp: tiempoActual 
        });
        console.log(`✅ Bitácora: Entrada de ${nombrePersona} registrada.`);
    } catch (error) { console.error(error); }
}

async function iniciarReconocimiento() {
    const arrancarDeteccion = async () => {
        const canvas = faceapi.createCanvasFromMedia(video);
        document.getElementById('contenedor-camara').append(canvas);
        const dimensiones = { width: video.width, height: video.height };
        faceapi.matchDimensions(canvas, dimensiones);

        setInterval(async () => {
            const detecciones = await faceapi.detectAllFaces(video).withFaceLandmarks().withFaceDescriptors();
            const deteccionesRedimensionadas = faceapi.resizeResults(detecciones, dimensiones);
            canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);

            deteccionesRedimensionadas.forEach(deteccion => {
                const mejorMatch = comparadorFacial.findBestMatch(deteccion.descriptor);
                const box = deteccion.detection.box; 

                if (mejorMatch.label !== 'unknown') {
                    mensaje.innerText = `¡ACCESO CONCEDIDO: BIENVENIDO ${mejorMatch.label.toUpperCase()}!`;
                    mensaje.style.color = "lightgreen";
                    registrarAcceso(mejorMatch.label);
                } else {
                    mensaje.innerText = "ACCESO DENEGADO: Persona no registrada.";
                    mensaje.style.color = "red";
                }   
                new faceapi.draw.DrawBox(box, { 
                    label: mejorMatch.toString(), 
                    boxColor: mejorMatch.label === 'unknown' ? 'red' : 'green' 
                }).draw(canvas);
            });
        }, 200);
    };

    if (video.readyState >= 3) arrancarDeteccion();
    else video.addEventListener('playing', arrancarDeteccion);
}

async function calcularFaltas() {
    try {
        const grupoSeleccionado = document.getElementById('selectGrupo').value;
        const horaInicioHTML = document.getElementById('horaInicio').value;
        const horaFinHTML = document.getElementById('horaFin').value;
        const reunionSeleccionada = document.getElementById('inputReunion').value.trim();

        // NUEVO FRENO: Si el grupo está vacío (escribieron un typo o no eligieron de la lista)
        if (grupoSeleccionado === "") {
            alert("⚠️ Acción Detenida: Debes seleccionar un grupo válido de la lista desplegable.");
            return;
        }

        if (horaInicioHTML === "" || horaFinHTML === "" || reunionSeleccionada === "") {
            // Mostramos una alerta al usuario
            alert("⚠️ ¡Espera! Por favor llena las horas (Desde / Hasta) y el nombre de la clase antes de generar el reporte.");
            // El 'return' actúa como un freno de mano: detiene la función aquí mismo y no ejecuta el resto del código
            return; 
        }

        if (!horaInicioHTML || !horaFinHTML || !reunionSeleccionada) {
            alert("⚠️ Completa las horas y el nombre de la reunión.");
            return;
        }

        // Guardar la reunión automáticamente para que aparezca en el buscador la próxima vez
        await setDoc(doc(db, "Reuniones", reunionSeleccionada), { nombre: reunionSeleccionada });

        let listaInvitados = (grupoSeleccionado === "todos") ? Object.keys(diccionarioUsuarios) : (basesDeDatosGrupos[grupoSeleccionado] || []);

        const hoy = new Date();
        const [hInicio, mInicio] = horaInicioHTML.split(':');
        const [hFin, mFin] = horaFinHTML.split(':');
        const horaInicioTs = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate(), parseInt(hInicio), parseInt(mInicio), 0).getTime(); 
        const horaFinTs = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate(), parseInt(hFin), parseInt(mFin), 0).getTime();

        const consulta = query(collection(db, "Historial"), where("fecha", "==", hoy.toLocaleDateString()));
        const resultados = await getDocs(consulta);

        let correosAsistentes = new Set(); 
        resultados.forEach((doc) => {
            const datos = doc.data();
            if (datos.correo && datos.timestamp >= horaInicioTs && datos.timestamp <= horaFinTs) {
                correosAsistentes.add(datos.correo);
            }
        });

        let asistentes = [];
        let ausentes = [];

        listaInvitados.forEach(correoInvitado => {
            const infoUser = diccionarioUsuarios[correoInvitado] || { nombre: "Desconocido", grupos: ["Sin Grupo"] };
            const estructurado = { nombre: infoUser.nombre, correo: correoInvitado, grupos: infoUser.grupos };

            if (correosAsistentes.has(correoInvitado)) {
                asistentes.push(estructurado);
            } else {
                ausentes.push(estructurado);
                
                //¡Llamamos al cartero!
                enviarCorreoFalta(estructurado.nombre, estructurado.correo, reunionSeleccionada);
            }
        });

        // Dibujar el reporte en pantalla de forma bonita
        const areaReporte = document.getElementById('areaReporte');
        areaReporte.style.display = 'block';

        let html = `<h3 style="color: #fbc531; margin-top:0; border-bottom: 1px solid #444; padding-bottom:5px;">📊 ${reunionSeleccionada.toUpperCase()}</h3>`;
        html += `<p style="margin: 5px 0;"><strong>Filtro:</strong> Grupo ${grupoSeleccionado.toUpperCase()}</p>`;
        
        html += `<h4 style="color: #2ecc71; margin-bottom:5px;">✅ ASISTIERON (${asistentes.length}):</h4><ul>`;
        if(asistentes.length === 0) html += `<li>Nadie asistió en este rango.</li>`;
        asistentes.forEach(p => html += `<li><strong>${p.nombre}</strong> <span style="color:#aaa; font-size:11px;">(${p.grupos.join(', ')})</span></li>`);
        html += `</ul>`;

        html += `<h4 style="color: #e74c3c; margin-bottom:5px;">❌ FALTARON (${ausentes.length}):</h4><ul>`;
        if(ausentes.length === 0) html += `<li>¡Asistencia perfecta! No faltó nadie.</li>`;
        ausentes.forEach(p => html += `<li><strong>${p.nombre}</strong> <span style="color:#aaa; font-size:11px;">(${p.grupos.join(', ')})</span></li>`);
        html += `</ul>`;

        areaReporte.innerHTML = html;

    } catch (error) { console.error(error); alert("Error al procesar reporte."); }
}

async function enviarCorreoFalta(nombrePersona, correoPersona, nombreClase) {
    // 1. Preparamos los datos exactos que pide tu plantilla de EmailJS
    let parametros = {
        nombre: nombrePersona,
        correo_destino: correoPersona,
        clase: nombreClase,
        enlace_drive: "Enlace pendiente de añadir..." // Por ahora es texto fijo
    };

    try {
        // 2. Le decimos al cartero que entregue el mensaje
        // OJO: Reemplaza con tu Service ID y tu Template ID
        let respuesta = await emailjs.send("service_s9ugx0j", "template_ayapn8q", parametros);
        console.log("✅ Correo enviado con éxito a: " + correoPersona);
    } catch (error) {
        console.error("❌ Error al enviar correo a: " + correoPersona, error);
    }
}

const modal = document.getElementById('modalAdmin');
document.getElementById('btnAbrirAdmin').addEventListener('click', () => { modal.style.display = 'flex'; });
document.getElementById('btnCerrarModal').addEventListener('click', () => { 
    modal.style.display = 'none'; 
    document.getElementById('areaReporte').style.display = 'none'; // Resetea el reporte visual al cerrar
});
document.getElementById('btnCerrarDia').addEventListener('click', calcularFaltas);

// --- MOTOR DEL BUSCADOR DE GRUPOS EN EL MODAL ---
const buscadorGruposModal = document.getElementById('buscadorGruposModal');
const resultadosGruposModal = document.getElementById('resultadosGruposModal');
const selectGrupoOculto = document.getElementById('selectGrupo');

// Cuando escribe
buscadorGruposModal.addEventListener('input', () => {
    let texto = buscadorGruposModal.value.toLowerCase().trim();
    resultadosGruposModal.innerHTML = ""; 
    
    // IMPORTANTE: Al primer teclazo, borramos el valor oculto. 
    // Así evitamos que manden correos al grupo anterior por error.
    selectGrupoOculto.value = ""; 

    let coincidencias = texto === "" 
        ? opcionesGrupos 
        : opcionesGrupos.filter(g => g.texto.toLowerCase().includes(texto));

    // Si escribe pura basura que no existe
    if (coincidencias.length === 0) {
        let divError = document.createElement("div");
        divError.className = "dropdown-item";
        divError.style.color = "red";
        divError.innerText = "❌ No existe este grupo";
        resultadosGruposModal.appendChild(divError);
    } else {
        coincidencias.forEach(match => {
            let div = document.createElement("div");
            div.className = "dropdown-item";
            div.innerText = match.texto; 
            
            // Solo si da clic en una opción válida, se guarda el valor real
            div.addEventListener("click", () => {
                buscadorGruposModal.value = match.texto; 
                selectGrupoOculto.value = match.valor;  
                resultadosGruposModal.style.display = "none";
            });
            resultadosGruposModal.appendChild(div);
        });
    }

    resultadosGruposModal.style.display = "block";
});

// UX MEJORADA: Al dar clic, seleccionamos todo el texto para que al teclear se borre lo anterior
buscadorGruposModal.addEventListener('focus', () => {
    buscadorGruposModal.select(); 
    buscadorGruposModal.dispatchEvent(new Event('input')); 
});

// Ocultar si da clic fuera del buscador y limpiar typos
document.addEventListener("click", (e) => {
    if (e.target !== buscadorGruposModal && e.target !== resultadosGruposModal) {
        resultadosGruposModal.style.display = "none";
        
        // Si dieron clic fuera y no hay un grupo oficial seleccionado, borramos su texto inventado
        if (selectGrupoOculto.value === "") {
            buscadorGruposModal.value = "";
        }
    }
});


inicializarEscaner();