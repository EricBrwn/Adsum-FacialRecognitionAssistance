import { db } from "./firebase-config.js";
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

async function registerNewTeacher() {
    const nameInput = document.getElementById('newTeacherName').value.trim();
    const emailInput = document.getElementById('newTeacherEmail').value.trim().toLowerCase();
    const groupsInput = document.getElementById('newTeacherGroups').value.trim();

    if (!nameInput || !emailInput || !groupsInput) {
        alert("⚠️ All fields are required.");
        return;
    }

    // Convertimos la cadena de texto separada por comas en un arreglo limpio
    const groupsArray = groupsInput.split(',').map(g => g.trim()).filter(g => g !== "");

    try {
        // Guardamos en la colección Teachers
        await setDoc(doc(db, "Teachers", emailInput), {
            name: nameInput,
            groups: groupsArray
        });

        alert(`✅ Success! Teacher ${nameInput} registered successfully with ${groupsArray.length} groups.`);
        
        // Limpiar formulario
        document.getElementById('newTeacherName').value = "";
        document.getElementById('newTeacherEmail').value = "";
        document.getElementById('newTeacherGroups').value = "";

    } catch (error) {
        console.error("Database Error:", error);
        alert("❌ Failed to register teacher. Check console for details.");
    }
}

document.getElementById('registerTeacherBtn').addEventListener('click', registerNewTeacher);