import { db } from "./firebase-config.js";
import { collection, getDocs, doc, setDoc } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

// UI Elements
const statusMessage = document.getElementById('statusMessage');
const previewImage = document.getElementById('previewImage');
const registerBtn = document.getElementById('registerBtn');
const photoInput = document.getElementById('photoInput');
const userEmailInput = document.getElementById('userEmail');

// Group Search Elements
const groupSearch = document.getElementById('groupSearch');
const searchResults = document.getElementById('searchResults');
const groupsContainer = document.getElementById('groupsContainer');

let allGroupsMemory = []; 
let faceDescriptor = null; 

async function initialize() {
    try {
        statusMessage.innerText = "1/2 Loading AI engine...";
        await Promise.all([
            faceapi.nets.ssdMobilenetv1.loadFromUri('./models'),
            faceapi.nets.faceLandmark68Net.loadFromUri('./models'),
            faceapi.nets.faceRecognitionNet.loadFromUri('./models')
        ]);
        
        statusMessage.innerText = "2/2 Synchronizing existing groups...";
        await loadGroupsFromFirebase();

        statusMessage.innerText = "System ready. Please fill in your details.";
        statusMessage.style.color = "blue";
    } catch (error) {
        console.error(error);
        statusMessage.innerText = "Error initializing registration.";
        statusMessage.style.color = "red";
    }
}

// 1. Scans Firebase but DOES NOT draw anything, only saves to memory
async function loadGroupsFromFirebase() {
    const querySnapshot = await getDocs(collection(db, "Users"));
    const existingGroups = new Set();
    
    querySnapshot.forEach(doc => {
        const data = doc.data();
        if (data.groups && Array.isArray(data.groups)) {
            data.groups.forEach(g => {
                if (g !== "No Group") existingGroups.add(g);
            });
        }
    });
    allGroupsMemory = Array.from(existingGroups); 
}

// 2. Converts text into a selected pill checkbox
function addCheckboxGroup(groupName) {
    let cleanName = groupName.trim();
    if (cleanName === "") return;

    const alreadyExists = Array.from(groupsContainer.querySelectorAll('input'))
                               .some(i => i.value.toLowerCase() === cleanName.toLowerCase());
    
    if (!alreadyExists) {
        let label = document.createElement("label");
        label.className = "group-option";
        
        let checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = cleanName;
        checkbox.checked = true; // Always checked by default!
        
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(" " + cleanName));
        groupsContainer.appendChild(label);
    }

    groupSearch.value = "";
    searchResults.style.display = "none";
}

// 3. Search engine logic when typing
groupSearch.addEventListener('input', () => {
    let text = groupSearch.value.toLowerCase().trim();
    searchResults.innerHTML = ""; 

    if (text === "") {
        searchResults.style.display = "none";
        return;
    }

    let matches = allGroupsMemory.filter(g => g.toLowerCase().includes(text));

    matches.forEach(match => {
        let div = document.createElement("div");
        div.className = "dropdown-item";
        div.innerText = match;
        div.addEventListener("click", () => addCheckboxGroup(match));
        searchResults.appendChild(div);
    });

    let createDiv = document.createElement("div");
    createDiv.className = "dropdown-item";
    createDiv.style.fontWeight = "bold";
    createDiv.style.color = "#007bff";
    createDiv.innerText = `+ Create and select "${groupSearch.value}"`;
    createDiv.addEventListener("click", () => {
        addCheckboxGroup(groupSearch.value);
        if (!allGroupsMemory.includes(groupSearch.value)) {
            allGroupsMemory.push(groupSearch.value); 
        }
    });
    searchResults.appendChild(createDiv);

    searchResults.style.display = "block"; 
});

// 4. "Foolproof": If user presses Enter, automatically creates/selects
groupSearch.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        let text = groupSearch.value.trim();
        if (text !== "") {
            addCheckboxGroup(text);
            if (!allGroupsMemory.includes(text)) allGroupsMemory.push(text);
        }
    }
});

// 5. Hide menu if clicking anywhere else on the screen
document.addEventListener("click", (e) => {
    if (e.target !== groupSearch && e.target !== searchResults) {
        searchResults.style.display = "none";
    }
});

// --- FACE SCANNER (NOW WITH IPHONE/HEIC SUPPORT) ---
photoInput.addEventListener('change', async () => {
    let file = photoInput.files[0];
    if (!file) return;
    
    registerBtn.disabled = true;

    // Detect if it's an iPhone photo (.heic)
    let fileName = file.name.toLowerCase();
    if (fileName.endsWith('.heic') || file.type === 'image/heic') {
        statusMessage.innerText = "Converting iPhone image (this might take a few seconds)...";
        statusMessage.style.color = "orange";
        
        try {
            // Magically convert the image to JPEG in the browser
            const convertedBlob = await heic2any({
                blob: file,
                toType: "image/jpeg",
                quality: 0.8 // Good quality, fast processing
            });
            
            // heic2any sometimes returns an array, ensure we grab the right file
            file = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
        } catch (error) {
            console.error("Error converting HEIC:", error);
            statusMessage.innerText = "❌ Error processing iPhone image.";
            statusMessage.style.color = "red";
            return;
        }
    }

    // Now, create the URL with the image (normal or converted)
    const imageUrl = URL.createObjectURL(file);
    previewImage.src = imageUrl;
    statusMessage.innerText = "Analyzing face...";
    statusMessage.style.color = "blue"; 

    // Analysis continues normally
    previewImage.onload = async () => {
        const detection = await faceapi.detectSingleFace(previewImage).withFaceLandmarks().withFaceDescriptor();
        if (detection) {
            statusMessage.innerText = "Face detected! ✅";
            statusMessage.style.color = "green";
            faceDescriptor = detection.descriptor;
            registerBtn.disabled = false;
        } else {
            statusMessage.innerText = "❌ Could not detect a clear face.";
            statusMessage.style.color = "red";
        }
    };

    previewImage.onerror = () => {
        statusMessage.innerText = "❌ Error: Could not display the image.";
        statusMessage.style.color = "red";
        registerBtn.disabled = true;
    };
});

// --- SAVE TO FIREBASE ---
registerBtn.addEventListener('click', async () => {
    const name = document.getElementById('userName').value.trim();
    const email = userEmailInput.value.trim();

    if (!name || !email) { 
        alert("Please fill in both name and email."); 
        return; 
    }

    let selectedCheckboxes = document.querySelectorAll('#groupsContainer input[type="checkbox"]:checked');
    let chosenGroups = [];
    selectedCheckboxes.forEach((checkbox) => {
        chosenGroups.push(checkbox.value);
    });

    if (chosenGroups.length === 0) {
        alert("⚠️ Hold on! Please select at least one group or create a new one before saving.");
        return;
    }

    registerBtn.innerText = "Saving...";
    registerBtn.disabled = true;

    try {
        await setDoc(doc(db, "Users", email), {
            fullName: name,
            email: email,
            descriptor: Array.from(faceDescriptor), 
            registrationDate: new Date().toISOString(),
            groups: chosenGroups 
        });

        alert("Registration Successful!");
        location.reload(); 
    } catch (error) {
        console.error(error);
        alert("Error saving user.");
        registerBtn.disabled = false;
    }
});

initialize();