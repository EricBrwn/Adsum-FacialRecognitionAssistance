import { db } from "./firebase-config.js";
import { collection, getDocs, addDoc, query, where, doc, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const video = document.getElementById('camera');
const scannerMessage = document.getElementById('scannerMessage');

const recognitionTolerance = 0.45; // Adjust this value to be more or less strict on facial recognition

let knownFaces = []; 
let emailMap = {}; 
let groupDatabases = {}; 
let userDictionary = {}; // Saves complete object {email: {name, groups}}
let faceMatcher = null; 
let groupOptions = []; // Will store the list of groups for the searcher
let currentTeacherName = "Teacher";

// Initialize EmailJS with your Public Key
emailjs.init("PVySdKrUGNpDOYaCs");

async function initializeScanner() {
    try {
        scannerMessage.innerText = "1/3 Loading AI...";
        await faceapi.nets.ssdMobilenetv1.loadFromUri('./models');
        await faceapi.nets.faceLandmark68Net.loadFromUri('./models');
        await faceapi.nets.faceRecognitionNet.loadFromUri('./models');
        
        scannerMessage.innerText = "2/3 Turning on camera...";
        await turnOnCamera(); 

        scannerMessage.innerText = "3/3 Synchronizing Database...";
        await downloadFirebaseData();
        await loadSessionAutocomplete();
        
    } catch (error) {
        console.error(error);
        scannerMessage.innerText = "Critical error during initialization.";
        scannerMessage.style.color = "red";
    }
    startRecognition();
}

async function turnOnCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
    } catch (error) {
        alert("⛔ Could not access the camera.");
        throw error; 
    }
}

async function downloadFirebaseData() {
    try {
        knownFaces = []; emailMap = {}; groupDatabases = {}; userDictionary = {};
        const querySnapshot = await getDocs(collection(db, "Users"));
        
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            // Note: Now looking for 'fullName' to match English registration
            if (!data.fullName || !data.descriptor) return; 

            const name = String(data.fullName);
            const email = doc.id;
            emailMap[name] = email;
            
            // Note: Now looking for 'groups'
            const personGroups = data.groups || ["No Group"];
            
            // Fill the master dictionary for the final report
            userDictionary[email] = { name: name, groups: personGroups };
    
            personGroups.forEach(groupName => {
                if (!groupDatabases[groupName]) groupDatabases[groupName] = [];
                groupDatabases[groupName].push(email);
            });

            const labeledFace = new faceapi.LabeledFaceDescriptors(name, [new Float32Array(data.descriptor)]);
            knownFaces.push(labeledFace);
        });

        faceMatcher = new faceapi.FaceMatcher(knownFaces, recognitionTolerance);
        
        // Fill the smart group searcher
        groupOptions = [{ value: "all", text: "All registered users" }];
        for (const group in groupDatabases) {
            groupOptions.push({
                value: group,
                text: `${group} (${groupDatabases[group].length} people)`
            });
        }
        
        // Configure default values (leave blank to prevent accidental massive emails)
        document.getElementById('modalGroupSearch').value = "";
        document.getElementById('hiddenGroupSelect').value = "";
        document.getElementById('modalGroupSearch').placeholder = "Type to search...";

        scannerMessage.innerText = "System ready.";
        scannerMessage.style.color = "lightgreen";
    } catch (error) {
        console.error(error);
    }
}

async function loadSessionAutocomplete() {
    const sessionsSnapshot = await getDocs(collection(db, "Sessions"));
    const sessionDatalist = document.getElementById('sessionList');
    sessionDatalist.innerHTML = "";
    sessionsSnapshot.forEach(doc => {
        sessionDatalist.innerHTML += `<option value="${doc.id}"></option>`;
    });
}

let lastUserLog = {}; 
async function logAccess(personName) {
    const currentTime = Date.now(); 
    if (lastUserLog[personName] && (currentTime - lastUserLog[personName] < 60000)) return; 

    lastUserLog[personName] = currentTime;
    const personEmail = emailMap[personName] || "Unknown";

    try {
        const currentDate = new Date();
        await addDoc(collection(db, "History"), {
            name: personName,
            email: personEmail,
            date: currentDate.toLocaleDateString(), 
            time: currentDate.toLocaleTimeString(),  
            timestamp: currentTime 
        });
        console.log(`✅ Log: Entry for ${personName} registered.`);
    } catch (error) { console.error(error); }
}

async function startRecognition() {
    const runDetection = async () => {
        const canvas = faceapi.createCanvasFromMedia(video);
        document.getElementById('cameraContainer').append(canvas);
        const dimensions = { width: video.width, height: video.height };
        faceapi.matchDimensions(canvas, dimensions);

        setInterval(async () => {
            const detections = await faceapi.detectAllFaces(video).withFaceLandmarks().withFaceDescriptors();
            const resizedDetections = faceapi.resizeResults(detections, dimensions);
            canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);

            resizedDetections.forEach(detection => {
                const bestMatch = faceMatcher.findBestMatch(detection.descriptor);
                const box = detection.detection.box; 

                if (bestMatch.label !== 'unknown') {
                    scannerMessage.innerText = `DETECTED: ${bestMatch.label.toUpperCase()}`;
                    scannerMessage.style.color = "lightgreen";
                    logAccess(bestMatch.label);
                } else {
                    scannerMessage.innerText = "DETECTED: Unregistered person.";
                    scannerMessage.style.color = "red";
                }   
                new faceapi.draw.DrawBox(box, { 
                    label: bestMatch.toString(), 
                    boxColor: bestMatch.label === 'unknown' ? 'red' : 'green' 
                }).draw(canvas);
            });
        }, 200);
    };

    if (video.readyState >= 3) runDetection();
    else video.addEventListener('playing', runDetection);
}

async function calculateAbsences() {
    try {
        const selectedGroup = document.getElementById('hiddenGroupSelect').value;
        const startTimeHTML = document.getElementById('startTime').value;
        const endTimeHTML = document.getElementById('endTime').value;
        const selectedSession = document.getElementById('sessionInput').value.trim();

        // FAILSAFE: Si el grupo está vacío
        if (selectedGroup === "") {
            alert("⚠️ Action Stopped: You must select a valid group from the dropdown list.");
            return;
        }

        if (startTimeHTML === "" || endTimeHTML === "" || selectedSession === "") {
            alert("⚠️ Hold on! Please fill in the times (From / To) and the session name before generating the report.");
            return; 
        }

        // Guarda la sesión en Firebase automáticamente
        await setDoc(doc(db, "Sessions", selectedSession), { name: selectedSession });

        let guestList = (selectedGroup === "all") ? Object.keys(userDictionary) : (groupDatabases[selectedGroup] || []);

        const today = new Date();
        const [hStart, mStart] = startTimeHTML.split(':');
        const [hEnd, mEnd] = endTimeHTML.split(':');
        const startTimeTs = new Date(today.getFullYear(), today.getMonth(), today.getDate(), parseInt(hStart), parseInt(mStart), 0).getTime(); 
        const endTimeTs = new Date(today.getFullYear(), today.getMonth(), today.getDate(), parseInt(hEnd), parseInt(mEnd), 0).getTime();

        const queryResult = query(collection(db, "History"), where("date", "==", today.toLocaleDateString()));
        const results = await getDocs(queryResult);

        let attendingEmails = new Set(); 
        results.forEach((doc) => {
            const data = doc.data();
            if (data.email && data.timestamp >= startTimeTs && data.timestamp <= endTimeTs) {
                attendingEmails.add(data.email);
            }
        });

        let attendees = [];
        let absentees = [];

        guestList.forEach(guestEmail => {
            const userInfo = userDictionary[guestEmail] || { name: "Unknown", groups: ["No Group"] };
            const structuredData = { name: userInfo.name, email: guestEmail, groups: userInfo.groups };

            if (attendingEmails.has(guestEmail)) {
                attendees.push(structuredData);
            } else {
                absentees.push(structuredData);
                // Llamada al correo con la nueva variable
                sendAbsenceEmail(structuredData.name, structuredData.email, selectedSession);
            }
        });

        // Dibuja el reporte visual
        const reportArea = document.getElementById('reportArea');
        reportArea.style.display = 'block';

        let html = `<h3 style="color: #fbc531; margin-top:0; border-bottom: 1px solid #444; padding-bottom:5px;">📊 ${selectedSession.toUpperCase()}</h3>`;
        html += `<p style="margin: 5px 0;"><strong>Filter:</strong> Group ${selectedGroup.toUpperCase()}</p>`;
        
        html += `<h4 style="color: #2ecc71; margin-bottom:5px;">✅ ATTENDED (${attendees.length}):</h4><ul>`;
        if(attendees.length === 0) html += `<li>Nobody attended during this timeframe.</li>`;
        attendees.forEach(p => html += `<li><strong>${p.name}</strong> <span style="color:#aaa; font-size:11px;">(${p.groups.join(', ')})</span></li>`);
        html += `</ul>`;

        html += `<h4 style="color: #e74c3c; margin-bottom:5px;">❌ ABSENT (${absentees.length}):</h4><ul>`;
        if(absentees.length === 0) html += `<li>Perfect attendance! Nobody was absent.</li>`;
        absentees.forEach(p => html += `<li><strong>${p.name}</strong> <span style="color:#aaa; font-size:11px;">(${p.groups.join(', ')})</span></li>`);
        html += `</ul>`;

        reportArea.innerHTML = html;


        // --- NUEVO: Enviar resumen al profesor ---
        const emailInput = document.getElementById('teacherEmailInput').value.trim();
        if (emailInput && selectedGroup !== "all") {
            sendTeacherSummaryEmail(emailInput, currentTeacherName, selectedGroup, selectedSession, attendees, absentees);
        }

    } catch (error) { 
        console.error("Error en el reporte:", error); 
        alert("Error processing report."); 
    }
}

//EMAILS
async function sendAbsenceEmail(personName, personEmail, sessionName) {
    // 1. Prepare exact data payload matching the new EmailJS template
    let parameters = {
        name: personName,
        target_email: personEmail,
        session_name: sessionName,
        drive_link: "Link pending addition..." 
    };

    try {
        // 2. Tell the postman to deliver the message
        let response = await emailjs.send("service_s9ugx0j", "template_ayapn8q", parameters);
        console.log("✅ Email successfully sent to: " + personEmail);
    } catch (error) {
        console.error("❌ Error sending email to: " + personEmail, error);
    }
}

async function sendTeacherSummaryEmail(teacherEmail, teacherName, group, session, attendees, absentees) {
    // Convertimos los arreglos en texto legible
    const attendeesText = attendees.length > 0 ? attendees.map(a => a.name).join(", ") : "Nadie asistió.";
    const absenteesText = absentees.length > 0 ? absentees.map(a => a.name).join(", ") : "Asistencia perfecta.";

    let parameters = {
        teacher_name: teacherName,
        teacher_email: teacherEmail,
        group_name: group,
        session_name: session,
        attendees_list: attendeesText,
        absentees_list: absenteesText
    };

    try {
        // OJO: Tendrás que cambiar "TEMPLATE_MAESTROS" por el ID real de tu nueva plantilla
        await emailjs.send("service_s9ugx0j", "template_49u2dbi", parameters);
        console.log("✅ Reporte resumen enviado al profesor: " + teacherEmail);
    } catch (error) {
        console.error("❌ Error enviando el resumen al profesor.", error);
    }
}

const adminModal = document.getElementById('adminModal');
document.getElementById('openAdminBtn').addEventListener('click', () => { adminModal.style.display = 'flex'; });
document.getElementById('closeModalBtn').addEventListener('click', () => { 
    adminModal.style.display = 'none'; 
    document.getElementById('reportArea').style.display = 'none'; // Reset visual report upon closing
});
document.getElementById('generateReportBtn').addEventListener('click', calculateAbsences);

// --- MODAL SMART GROUP SEARCHER ENGINE ---
const modalGroupSearch = document.getElementById('modalGroupSearch');
const modalGroupResults = document.getElementById('modalGroupResults');
const hiddenGroupSelect = document.getElementById('hiddenGroupSelect');

// When typing
modalGroupSearch.addEventListener('input', () => {
    let text = modalGroupSearch.value.toLowerCase().trim();
    modalGroupResults.innerHTML = ""; 
    
    // IMPORTANT: Clear hidden value on first keystroke to prevent accidental previous group selection
    hiddenGroupSelect.value = ""; 

    let matches = text === "" 
        ? groupOptions 
        : groupOptions.filter(g => g.text.toLowerCase().includes(text));

    // If writing garbage that doesn't exist
    if (matches.length === 0) {
        let errorDiv = document.createElement("div");
        errorDiv.className = "dropdown-item";
        errorDiv.style.color = "red";
        errorDiv.innerText = "❌ This group does not exist";
        modalGroupResults.appendChild(errorDiv);
    } else {
        matches.forEach(match => {
            let div = document.createElement("div");
            div.className = "dropdown-item";
            div.innerText = match.text; 
            
            // Only if valid option clicked, save real value
            div.addEventListener("click", () => {
                modalGroupSearch.value = match.text; 
                hiddenGroupSelect.value = match.value;  
                modalGroupResults.style.display = "none";
            });
            modalGroupResults.appendChild(div);
        });
    }

    modalGroupResults.style.display = "block";
});

// ENHANCED UX: Select all text on click to easily overwrite
modalGroupSearch.addEventListener('focus', () => {
    modalGroupSearch.select(); 
    modalGroupSearch.dispatchEvent(new Event('input')); 
});

// Hide if clicked outside and clean up typos
document.addEventListener("click", (e) => {
    if (e.target !== modalGroupSearch && e.target !== modalGroupResults) {
        modalGroupResults.style.display = "none";
        
        // If clicked outside without an official group selected, erase invented text
        if (hiddenGroupSelect.value === "") {
            modalGroupSearch.value = "";
        }
    }
});

async function loadTeacherGroups() {
    const emailInput = document.getElementById('teacherEmailInput').value.trim();
    
    if (!emailInput) {
        alert("⚠️ Please enter your teacher email first.");
        return;
    }

    try {
        const teacherRef = doc(db, "Teachers", emailInput);
        const teacherSnap = await getDoc(teacherRef); // ¡Aquí estaba el error antes!

        if (teacherSnap.exists()) {
            const teacherData = teacherSnap.data();
            currentTeacherName = teacherData.name;
            const teacherGroups = teacherData.groups || [];

            if (teacherGroups.length > 0) {
                // 1. Limpiamos las opciones globales de tu buscador inteligente
                groupOptions = []; 
                
                // 2. Agregamos SOLAMENTE los grupos de este profesor
                teacherGroups.forEach(group => {
                    // Calculamos cuántos alumnos hay basándonos en tu base de datos descargada
                    const count = groupDatabases[group] ? groupDatabases[group].length : 0;
                    groupOptions.push({
                        value: group,
                        text: `${group} (${count} people)`
                    });
                });

                // 3. Limpiamos visualmente el cuadro de búsqueda por si había algo escrito
                document.getElementById('modalGroupSearch').value = "";
                document.getElementById('hiddenGroupSelect').value = "";
                
                alert(`✅ Welcome ${teacherData.name}! Your groups have been loaded.`);
            } else {
                alert("⚠️ No groups assigned to this teacher yet.");
            }
        } else {
            alert("❌ Teacher not found in the database. Please check the email.");
        }
    } catch (error) {
        console.error("Error loading teacher groups:", error);
        alert("Error connecting to the database.");
    }
}

// Conectamos el botón nuevo con la función
document.getElementById('loadGroupsBtn').addEventListener('click', loadTeacherGroups);

initializeScanner();