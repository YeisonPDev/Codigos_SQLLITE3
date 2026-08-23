import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

// --- Solución para __dirname con ES Modules ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Valor especial que representa "sin filtro de sede".
// NUNCA se guarda como sede de un estudiante, sólo se usa al consultar.
const TODAS_SEDES = "TODAS";

// Normaliza lo que llega del cliente: "" / "TODAS" / undefined -> null (sin sede)
function normalizarSede(valor) {
  const s = (valor ?? "").toString().trim();
  if (!s || s.toUpperCase() === TODAS_SEDES) return null;
  return s;
}

// Las sedes se comparan sin distinguir mayúsculas para que "Merced",
// "merced" y "MERCED" no se conviertan en tres sedes distintas.
// Se escapan los comodines de LIKE para que la comparación sea exacta.
function filtroSede(consulta, sede) {
  const patron = sede.replace(/([\\%_*])/g, "\\$1");
  return consulta.ilike("Sede", patron);
}

// --- Middlewares ---
app.use(cors());
app.use(express.json());

// --- Inicializar Supabase ---
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error(
    "❌ ERROR: Faltan variables de entorno SUPABASE_URL o SUPABASE_KEY",
  );
  process.exit(1);
}
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

// --- Servir el frontend ---
app.use(express.static(path.join(__dirname, "../frontend")));

/* ====================================
   1. OBTENER TODOS LOS REGISTROS
   Filtro opcional por sede:  /api/codigos?sede=Merced
   Sin el parámetro (o con sede=TODAS) devuelve todas las sedes.
==================================== */
app.get("/api/codigos", async (req, res) => {
  try {
    const sede = normalizarSede(req.query.sede);

    let consulta = supabase
      .from("Codigos")
      .select("*")
      .order("id", { ascending: true });

    // Sede específica -> equivalente a  WHERE Sede = 'Merced'
    if (sede) consulta = filtroSede(consulta, sede);

    const { data, error } = await consulta;

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error("❌ Error al obtener registros:", err.message);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

/* ====================================
   1.b SEDES DISPONIBLES (DINÁMICAS)
   Se descubren desde la propia base de datos:
   son los valores distintos de la columna Sede.
   No hay ninguna lista fija en el código.
==================================== */
app.get("/api/sedes", async (req, res) => {
  try {
    const { data, error } = await supabase.from("Codigos").select("Sede");

    if (error) throw error;

    // Valores distintos, agrupando variantes de mayúsculas/minúsculas
    const unicas = new Map();
    for (const r of data) {
      const sede = (r.Sede ?? "").trim();
      if (sede && !unicas.has(sede.toLowerCase())) {
        unicas.set(sede.toLowerCase(), sede);
      }
    }

    const sedes = [...unicas.values()].sort((a, b) => a.localeCompare(b, "es"));

    res.json(sedes);
  } catch (err) {
    console.error("❌ Error al obtener sedes:", err.message);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

/* ====================================
   Un mismo código puede repetirse en sedes distintas.
   Lo que NO se permite es el mismo código dos veces
   dentro de la MISMA sede (codigo + sede es único).
==================================== */
async function existeCodigoEnSede(Codigo, sede, ignorarId = null) {
  let consulta = supabase.from("Codigos").select("id").eq("Codigo", Codigo);

  consulta = sede ? filtroSede(consulta, sede) : consulta.is("Sede", null);
  if (ignorarId) consulta = consulta.neq("id", ignorarId);

  const { data, error } = await consulta;
  if (error) throw error;
  return data.length > 0;
}

/* ====================================
   2. AGREGAR UN NUEVO REGISTRO
==================================== */
app.post("/api/codigos", async (req, res) => {
  try {
    const { Nombre, Codigo, Docente, Encargado } = req.body;
    const Sede = normalizarSede(req.body.Sede);

    if (await existeCodigoEnSede(Codigo, Sede)) {
      return res.status(409).json({
        error: `El código ${Codigo} ya existe en la sede ${Sede || "(sin sede)"}`,
      });
    }

    const { data, error } = await supabase
      .from("Codigos")
      .insert([{ Nombre, Codigo, Docente, Encargado, Sede }])
      .select();

    if (error) throw error;

    res.json({ success: true, nuevo: data[0] });
  } catch (err) {
    console.error("❌ Error insertando registro:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ====================================
   3. ACTUALIZAR REGISTRO EXISTENTE
==================================== */
app.put("/api/codigos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { Nombre, Codigo, Docente, Encargado } = req.body;
    const Sede = normalizarSede(req.body.Sede);

    // Verificar que el registro exista
    const { data: existe, error: errorExiste } = await supabase
      .from("Codigos")
      .select("id")
      .eq("id", id);

    if (errorExiste) throw errorExiste;
    if (existe.length === 0) {
      return res.status(404).json({ error: "Registro no encontrado" });
    }

    if (await existeCodigoEnSede(Codigo, Sede, id)) {
      return res.status(409).json({
        error: `El código ${Codigo} ya existe en la sede ${Sede || "(sin sede)"}`,
      });
    }

    const { data, error } = await supabase
      .from("Codigos")
      .update({ Nombre, Codigo, Docente, Encargado, Sede })
      .eq("id", id)
      .select();

    if (error) throw error;

    res.json({ success: true, actualizado: data[0] });
  } catch (err) {
    console.error("❌ Error actualizando registro:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ====================================
   4. ELIMINAR UN REGISTRO
==================================== */
app.delete("/api/codigos/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("Codigos")
      .delete()
      .eq("id", id)
      .select();

    if (error) throw error;
    if (data.length === 0) {
      return res.status(404).json({ error: "Registro no encontrado" });
    }

    res.json({ success: true, eliminado: data[0] });
  } catch (err) {
    console.error("❌ Error eliminando registro:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ====================================
   5. LOGIN SENCILLO (HARDCODED)
==================================== */
app.post("/api/login", (req, res) => {
  const { usuario, password } = req.body;
  if (usuario === "root" && password === "123") {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: "Credenciales inválidas" });
  }
});
/* ====================================
   RUTAS PARA TABLA GRADOS
==================================== */
// Obtener todos los estudiantes
app.get("/api/grados", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("grados")
      .select("*")
      .order("Estudiante", { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("❌ Error obteniendo estudiantes:", err.message);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
// Buscar estudiante por Código o Nombre
app.get("/api/grados/buscar", async (req, res) => {
  const { query } = req.query;
  try {
    const { data, error } = await supabase
      .from("grados")
      .select("*")
      .or(`Codigo.eq.${query},Estudiante.ilike.%${query}%`);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("❌ Error buscando estudiante:", err.message);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Actualizar asistencia
app.put("/api/grados/asistencia/:id", async (req, res) => {
  const { id } = req.params;
  const { estado1, estado2 } = req.body;

  try {
    const { data, error } = await supabase
      .from("grados")
      .update({ estado1, estado2 })
      .eq("id", id)
      .select();

    if (error) throw error;
    res.json({ success: true, actualizado: data[0] });
  } catch (err) {
    console.error("❌ Error actualizando asistencia:", err.message);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

/* ====================================
   LOGIN SENCILLO
==================================== */
app.post("/api/login", (req, res) => {
  const { usuario, password } = req.body;
  if (usuario === "root" && password === "123") {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: "Credenciales inválidas" });
  }
});
/* ====================================
   RUTA PARA ENTREGAR CONFIGURACIÓN DE SUPABASE
==================================== */
app.get("/api/config", (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_KEY,
  });
});

/* ====================================
   MANEJO DE RUTAS NO ENCONTRADAS
==================================== */
app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

/* ====================================
   INICIAR SERVIDOR
==================================== */
app.listen(PORT, () => {
  const url = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : `http://localhost:${PORT}`;

  console.log(`🚀 Servidor corriendo en: ${url}`);
});
