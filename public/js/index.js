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
        
        // Renderizar el select de grupos
        const selectHTML = document.getElementById('selectGrupo');
        selectHTML.innerHTML = '<option value="todos">Todos los registrados</option>'; 
        for (const grupo in basesDeDatosGrupos) {
            selectHTML.innerHTML += `<option value="${grupo}">${grupo} (${basesDeDatosGrupos[grupo].length} personas)</option>`;
        }
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
            
            if (correosAsistentes.has(correoInvitado)) asistentes.push(estructurado);
            else ausentes.push(estructurado);
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

const modal = document.getElementById('modalAdmin');
document.getElementById('btnAbrirAdmin').addEventListener('click', () => { modal.style.display = 'flex'; });
document.getElementById('btnCerrarModal').addEventListener('click', () => { 
    modal.style.display = 'none'; 
    document.getElementById('areaReporte').style.display = 'none'; // Resetea el reporte visual al cerrar
});
document.getElementById('btnCerrarDia').addEventListener('click', calcularFaltas);

inicializarEscaner();