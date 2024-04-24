require("dotenv").config();

const app = require("express")();
const fileUpload = require("express-fileupload");
const fs = require("fs");
const xlsx = require("xlsx");
const path = require("path");
const cors = require("cors");
const bodyParser = require("body-parser");
const oneBillDb = require("./db/onedb");
const archiver = require("archiver");
app.use(cors());

// Add the express-fileupload middleware
app.use(fileUpload({ createParentPath: true }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json()); // Use body-parser.json for JSON data

const zipFile = (createdfiles, res) => {
  const archiveName = "report.zip";

  const output = fs.createWriteStream(archiveName);
  const archive = archiver("zip");

  archive.on("error", (err) => {
    throw err; // Rethrow error for Express error handling
  });

  output.on("end", function () {
    console.log("Data has been drained");
  });

  // good practice to catch warnings (ie stat failures and other non-blocking errors)
  archive.on("warning", function (err) {
    if (err.code === "ENOENT") {
      // log warning
    } else {
      // throw error
      throw err;
    }
  });

  archive.pipe(output);

  createdfiles.forEach((file) => {
    const filePath = path.join(__dirname, "generated-report", file);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: file }); // Preserve original filenames in the archive
    }
  });

  output.on("close", () => {
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename=${archiveName}`);
    fs.createReadStream(archiveName).pipe(res);
    setTimeout(() => {
      const folderPath = path.join(__dirname, "generated-report");
      fs.unlinkSync(archiveName);
      fs.rmSync(folderPath, { recursive: true });
    }, 1500);
  });
  archive.finalize();
};

const formatDate = (date) => {
  if (!date) {
    return null;
  }
  const year = parseInt(date.split("-")[2]);
  const month = parseInt(date.split("-")[1]) - 1; // Months are zero-indexed in JS
  const day = parseInt(date.split("-")[0]);

  const dateObject = new Date(year, month, day);
  return dateObject;
};

app.post("/report", async (req, res) => {
  const { fromDate, toDate, selectedData } = req.body;
  await oneBillDb.connectDB();

  const createFile = (data, fileName) => {
    const dataToJson = JSON.stringify(data);
    const worksheet = xlsx.utils.json_to_sheet(JSON.parse(dataToJson));
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, "Sheet1");

    if (!fs.existsSync("generated-report")) {
      fs.mkdirSync("generated-report");
    }

    const name = fileName + " .xlsx";

    const savedFilePath = path.join(__dirname, "generated-report", name);
    xlsx.writeFile(workbook, savedFilePath);
    return name;
  };
  const fromDateFormated = new Date(fromDate);
  const toDateFormated = new Date(toDate);

  const getSelectedData = [...selectedData, "nullData"];

  const createdfiles = [];
  for (const selectedCategory of getSelectedData) {
    const getReport = await oneBillDb[selectedCategory]
      .find({
        "Credit Date": { $gte: fromDateFormated, $lte: toDateFormated },
      })
      .select("-comments -__v -_id")
      .exec();

    const data = [];
    const jsondata = JSON.stringify(getReport);
    const parsedData = JSON.parse(jsondata);

    parsedData.forEach((item) => {
      const formattedDate = new Date(item["Credit Date"])
        .toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })
        .split(" ");
      const date = `${formattedDate[0]}-${formattedDate[1]}-${formattedDate[2]}`;

      const updateDate = {
        ...item,
        "Collection Date": date,
        "Credit Date": date,
      };
      data.push(updateDate);
    });

    const fileName = createFile(data, selectedCategory);
    createdfiles.push(fileName);
  }

  if (
    fs.existsSync(path.join(__dirname, "generated-report", createdfiles[0]))
  ) {
    zipFile(createdfiles, res);
  }
});

app.post("/upload", async (req, res) => {
  const files = req.files;

  // Declare the variable `exists` outside of the `forEach()` loop.
  let exists = false;
  let file;
  let fileName;

  Object.keys(files).forEach(async (key) => {
    const filePath = path.join(__dirname, "excel-file", files[key].name);
    file = filePath;
    fileName = files[key].name;

    // Move the file to the destination directory.
    await files[key].mv(filePath, (err) => {
      if (err) {
        return res.status(200).json({
          status: 500,
          message: "Upload failed server side error",
          title: "Upload Failed",
        });
      }
    });
  });

  await oneBillDb.connectDB();

  async function ConvetToJson(excelFilePath) {
    const workbook = xlsx.readFile(excelFilePath);
    const sheetName = workbook.SheetNames[0];
    const rawData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
    });
    return rawData;
  }

  const auditData = async (data) => {
    const categories = {
      10: "examination_semester",
      20: "admission_processing_fee",
      21: "admission_fee",
      22: "admission_retain",
      30: "drgs_admission_processing_fee",
      31: "drgs_challan",
      40: "hostel_accomodation_fee_boys",
      41: "hostel_accomodation_fee_girls",
      43: "hostel_accomodation_fee_girls_pg",
      50: "examination_annual_certificate",
      51: "general_branch_annual",
      52: "examination_annual_exam_fee",
      53: "general_branch_on_campus",
      54: "examination_semester_affailated_college",
      61: "sutc",
    };

    data.map(async (record) => {
      const getChallan = record[8]?.toString()?.substr(0, 2);
      const getCategorie = await categories[getChallan];
      const challan = Number(record[8]);
      const barnchCode = Number(record[0]);
      const depositSlipNo = Number(record[2]);
      const collectionDate = formatDate(record[3]);
      const creditDate = formatDate(record[7]);

      if (getCategorie === undefined) {
        oneBillDb["nullData"].create({
          "Branch Code": barnchCode || 0,
          "Branch Name": record[1] || "No Data",
          "Deposit Slip No": depositSlipNo || 0,
          "Collection Date": collectionDate,
          "Mode of Payment": record[4] || "No Data",
          Amount: record[6] || 0,
          "Credit Date": creditDate,
          "Challan Number": challan || 0,
          "Student Name": record[9] || "No Data",
          "Father Name": record[10] || "No Data",
          Surname: record[11] || "No Data",
          CNIC: record[12] || "No Data",
          Program: record[13] || "No Data",
          Description: record[14] || "No Data",
        });
        return;
      }

      oneBillDb[getCategorie].create({
        "Branch Code": barnchCode || 0,
        "Branch Name": record[1] || "No Data",
        "Deposit Slip No": depositSlipNo || 0,
        "Collection Date": collectionDate,
        "Mode of Payment": record[4] || "No Data",
        Amount: record[6] || 0,
        "Credit Date": creditDate,
        "Challan Number": challan || 0,
        "Student Name": record[9] || "No Data",
        "Father Name": record[10] || "No Data",
        Surname: record[11] || "No Data",
        CNIC: record[12] || "No Data",
        Program: record[13] || "No Data",
        Description: record[14] || "No Data",
      });
    });
  };

  setTimeout(async () => {
    const data = await ConvetToJson(file);

    if (data[3][0] !== "00427992409403 - UOS 01 1B") {
      exists = true;
      res.status(200).json({
        status: 400,
        message: "Please dont upload wrong file",
        title: "Wrong file",
      });
      const folderPath = path.join(__dirname, "excel-file");
      fs.rmSync(folderPath, { recursive: true });
      return;
    }
    const categories = {
      10: "examination_semester",
      20: "admission_processing_fee",
      21: "admission_fee",
      22: "admission_retain",
      30: "drgs_admission_processing_fee",
      31: "drgs_challan",
      40: "hostel_accomodation_fee_boys",
      41: "hostel_accomodation_fee_girls",
      43: "hostel_accomodation_fee_girls_pg",
      50: "examination_annual_certificate",
      51: "general_branch_annual",
      52: "examination_annual_exam_fee",
      53: "general_branch_on_campus",
      54: "examination_semester_affailated_college",
      61: "sutc",
    };
    const getCategorie = data[13][8].substr(0, 2);
    const isTheDataExsits = await oneBillDb[categories[getCategorie]]?.find({
      "Challan Number": Number(data[13][8]),
    });

    if (isTheDataExsits.length > 0) {
      exists = true;
      res.status(200).json({
        status: 400,
        message: "please dont upload the already uploaded file",
        title: "Same File",
      });
      const folderPath = path.join(__dirname, "excel-file");
      fs.rmSync(folderPath, { recursive: true });
      return;
    }

    const execl = [];
    for (let i = 0; i < data.length; i++) {
      if (i > 9) {
        execl.push(data[i]);
      }
    }
    execl.pop();

    await auditData(execl);
    if (!exists) {
      const folderPath = path.join(__dirname, "excel-file");
      fs.rmSync(folderPath, { recursive: true });
      return res
        .status(200)
        .json({ status: 200, message: "file successfully uploaded" });
    }
  }, 1000);
});

app.listen("3000", () => {
  console.log("Server is running on port 3000");
});
